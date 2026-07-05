/**
 * Gmail channel adapter (Gmail API over HTTPS, OAuth2).
 *
 * Cross-platform: it only makes HTTPS calls, so it runs anywhere Node 18+ does
 * (global fetch). It acts for ONE configured instance at a time via the
 * ChannelContext, whose `auth` holds that instance's OAuth2 credentials
 * (clientId, clientSecret, refreshToken). Those credentials live ONLY in the
 * local config and are never sent to the snazi server.
 *
 * Maps the channel contract onto Gmail:
 *   - listInboundSenders -> recent inbox senders (From addresses) + counts
 *   - readMessagesFrom   -> the thread with one address (both directions)
 *   - sendMessage        -> send a plain-text email (never gated)
 *
 * Scopes required on the refresh token: gmail.readonly (read) and gmail.send
 * (send), or a broader gmail scope.
 */
import type {
  ChannelAdapter,
  ChannelAvailability,
  ChannelContext,
  FilterRecord,
  FilterSpec,
  MessageAction,
  MessageActionParams,
  MessageActionResult,
  MessageRow,
  SenderSummary,
  SendOptions,
} from './types'
import { getAccessToken } from './oauth'
import {
  extractEmail,
  htmlToText,
  oauthAvailability,
  requireOAuth,
} from './mail'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const LABEL = 'Gmail'
const MAX_LIST = 100
const MAX_READ = 50
const MAX_BODY_CHARS = 20_000

interface GmailHeader {
  name: string
  value: string
}
interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}
interface GmailMessage {
  id: string
  internalDate?: string
  snippet?: string
  payload?: GmailPart & { headers?: GmailHeader[] }
}

async function token(ctx: ChannelContext): Promise<string> {
  const { clientId, clientSecret, refreshToken } = requireOAuth(ctx, LABEL)
  return getAccessToken({ tokenUrl: TOKEN_URL, clientId, clientSecret, refreshToken })
}

/** GET a Gmail API path (relative to API_BASE) and parse JSON. */
async function apiGet<T>(
  accessToken: string,
  path: string,
  query?: Record<string, string | string[]>
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, one)
    else url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gmail API ${path} failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

/** POST a Gmail API path (relative to API_BASE) with a JSON body, parse JSON. */
async function apiPost<T>(
  accessToken: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Gmail API ${path} failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
  }
  // Some Gmail endpoints (e.g. trash) return a body; others may be empty.
  const text = await res.text().catch(() => '')
  return (text ? JSON.parse(text) : {}) as T
}

/** DELETE a Gmail API path (relative to API_BASE). Expects an empty 204 body. */
async function apiDelete(accessToken: string, path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gmail API ${path} failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
}

/** A Gmail settings.filters resource (subset of fields we read/write). */
interface GmailFilter {
  id?: string
  criteria?: Record<string, unknown>
  action?: {
    addLabelIds?: string[]
    removeLabelIds?: string[]
    forward?: string
  }
}

/**
 * Translate a (simplified or raw) FilterSpec into a Gmail filter resource.
 * Raw `criteria`/`actions` win when provided; otherwise the simplified
 * from/to/subject/query + action are mapped to Gmail's label operations.
 */
function toGmailFilter(spec: FilterSpec): GmailFilter {
  // Raw passthrough: caller supplied native criteria/action objects.
  if (spec.criteria || spec.actions) {
    return {
      criteria: spec.criteria ?? {},
      action: (spec.actions as GmailFilter['action']) ?? {},
    }
  }

  const criteria: Record<string, unknown> = {}
  if (spec.from) criteria.from = spec.from
  if (spec.to) criteria.to = spec.to
  if (spec.subject) criteria.subject = spec.subject
  if (spec.query) criteria.query = spec.query
  if (Object.keys(criteria).length === 0) {
    throw new Error('Gmail filter needs at least one match: from, to, subject, or query.')
  }

  const action: NonNullable<GmailFilter['action']> = {}
  switch (spec.action) {
    case 'delete':
      action.addLabelIds = ['TRASH']
      break
    case 'archive':
      action.removeLabelIds = ['INBOX']
      break
    case 'markRead':
      action.removeLabelIds = ['UNREAD']
      break
    case 'label':
      if (!spec.labelId) throw new Error("Gmail 'label' action requires --label-id.")
      action.addLabelIds = [spec.labelId]
      break
    case 'forward':
      if (!spec.forwardTo) throw new Error("Gmail 'forward' action requires --forward-to.")
      action.forward = spec.forwardTo
      break
    default:
      throw new Error(
        `Gmail filter needs an action: delete | archive | markRead | label | forward.`
      )
  }
  return { criteria, action }
}

/** Build a short human summary line for a Gmail filter. */
function gmailFilterSummary(f: GmailFilter): string {
  const c = f.criteria ?? {}
  const match = Object.entries(c)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ') || '(any)'
  const a = f.action ?? {}
  const acts: string[] = []
  if (a.addLabelIds?.includes('TRASH')) acts.push('delete')
  if (a.removeLabelIds?.includes('INBOX')) acts.push('archive')
  if (a.removeLabelIds?.includes('UNREAD')) acts.push('markRead')
  const otherLabels = (a.addLabelIds ?? []).filter((l) => l !== 'TRASH')
  if (otherLabels.length) acts.push(`label:${otherLabels.join('+')}`)
  if (a.forward) acts.push(`forward:${a.forward}`)
  return `[${match}] -> ${acts.join(', ') || '(no action)'}`
}

function toFilterRecord(f: GmailFilter): FilterRecord {
  return { id: f.id ?? '', summary: gmailFilterSummary(f), raw: f }
}

function headerValue(msg: GmailMessage, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  )
  return h?.value ?? ''
}

function isoDate(msg: GmailMessage): string {
  const ms = Number(msg.internalDate)
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(0)
  return d.toISOString()
}

/** Walk a Gmail payload tree for the best text body (plain preferred). */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const decode = (data?: string): string =>
    data ? Buffer.from(data, 'base64url').toString('utf8') : ''

  // Direct body on a text part. Prefer text/html (htmlToText now preserves
  // links as [text](url), so unsubscribe URLs survive) over text/plain.
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return htmlToText(decode(payload.body.data))
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decode(payload.body.data)
  }
  // Multipart: prefer a text/html descendant (keeps links), else text/plain.
  const parts = payload.parts ?? []
  for (const p of parts) {
    if (p.mimeType === 'text/html' && p.body?.data) return htmlToText(decode(p.body.data))
  }
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) return decode(p.body.data)
  }
  for (const p of parts) {
    const nested = extractBody(p)
    if (nested) return nested
  }
  return ''
}

/** Run an async fn over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function epochSeconds(sinceMinutes: number): number {
  return Math.floor((Date.now() - sinceMinutes * 60_000) / 1000)
}

async function listMessageIds(
  accessToken: string,
  query: string,
  cap: number
): Promise<string[]> {
  const res = await apiGet<{ messages?: { id: string }[] }>(accessToken, '/messages', {
    q: query,
    maxResults: String(cap),
  })
  return (res.messages ?? []).slice(0, cap).map((m) => m.id)
}

export const gmailAdapter: ChannelAdapter = {
  id: 'gmail',
  displayName: 'Gmail',
  platforms: [], // any platform: pure HTTPS

  availability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async listInboundSenders(
    ctx: ChannelContext,
    sinceMinutes: number
  ): Promise<SenderSummary[]> {
    const accessToken = await token(ctx)
    const ids = await listMessageIds(
      accessToken,
      `in:inbox after:${epochSeconds(sinceMinutes)}`,
      MAX_LIST
    )
    const metas = await mapLimit(ids, 10, (id) =>
      apiGet<GmailMessage>(accessToken, `/messages/${id}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'Date'],
      })
    )
    const bySender = new Map<string, { count: number; latest: number }>()
    for (const m of metas) {
      const sender = extractEmail(headerValue(m, 'From'))
      if (!sender) continue
      const ts = Number(m.internalDate) || 0
      const cur = bySender.get(sender)
      if (cur) {
        cur.count += 1
        if (ts > cur.latest) cur.latest = ts
      } else {
        bySender.set(sender, { count: 1, latest: ts })
      }
    }
    return [...bySender.entries()]
      .map(([sender, v]) => ({
        sender,
        message_count: v.count,
        latest_at: new Date(v.latest || 0).toISOString(),
      }))
      .sort((a, b) => b.latest_at.localeCompare(a.latest_at))
  },

  async readMessagesFrom(
    ctx: ChannelContext,
    sender: string,
    sinceMinutes: number
  ): Promise<MessageRow[]> {
    const accessToken = await token(ctx)
    const addr = sender.toLowerCase()
    // Both directions: mail FROM them and mail we sent TO them, like iMessage.
    const ids = await listMessageIds(
      accessToken,
      `after:${epochSeconds(sinceMinutes)} (from:${addr} OR to:${addr})`,
      MAX_READ
    )
    const msgs = await mapLimit(ids, 10, (id) =>
      apiGet<GmailMessage>(accessToken, `/messages/${id}`, { format: 'full' })
    )
    const rows: MessageRow[] = msgs.map((m) => {
      const from = extractEmail(headerValue(m, 'From'))
      const incoming = from === addr
      const subject = headerValue(m, 'Subject').trim()
      const body = extractBody(m.payload).slice(0, MAX_BODY_CHARS)
      const text = subject ? `${subject}\n\n${body}`.trim() : body || m.snippet || ''
      return {
        date: isoDate(m),
        text,
        from_me: !incoming,
        direction: incoming ? ('incoming' as const) : ('outgoing' as const),
      }
    })
    return rows.sort((a, b) => a.date.localeCompare(b.date))
  },

  async performMessageAction(
    ctx: ChannelContext,
    action: MessageAction,
    params: MessageActionParams
  ): Promise<MessageActionResult> {
    const accessToken = await token(ctx)

    // Resolve the target message ids: a single id, or all from a sender.
    let ids: string[]
    if (params.messageId) {
      ids = [params.messageId]
    } else if (params.sender) {
      const sinceMinutes = params.sinceMinutes ?? 1440
      const addr = params.sender.toLowerCase()
      ids = await listMessageIds(
        accessToken,
        `after:${epochSeconds(sinceMinutes)} from:${addr}`,
        MAX_READ
      )
    } else {
      ids = []
    }

    if (ids.length === 0) return { affected: 0 }

    const act = async (id: string): Promise<void> => {
      switch (action) {
        case 'archive':
          await apiPost(accessToken, `/messages/${id}/modify`, {
            removeLabelIds: ['INBOX'],
          })
          return
        case 'delete':
          await apiPost(accessToken, `/messages/${id}/trash`)
          return
        case 'markRead':
          await apiPost(accessToken, `/messages/${id}/modify`, {
            removeLabelIds: ['UNREAD'],
          })
          return
        case 'markUnread':
          await apiPost(accessToken, `/messages/${id}/modify`, {
            addLabelIds: ['UNREAD'],
          })
          return
        default:
          throw new Error(`Unsupported Gmail action: ${action as string}`)
      }
    }

    await mapLimit(ids, 10, act)
    return { affected: ids.length }
  },

  filterAvailability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async createFilter(ctx: ChannelContext, spec: FilterSpec): Promise<FilterRecord> {
    const accessToken = await token(ctx)
    const filter = toGmailFilter(spec)
    const created = await apiPost<GmailFilter>(accessToken, '/settings/filters', filter)
    return toFilterRecord(created)
  },

  async listFilters(ctx: ChannelContext): Promise<FilterRecord[]> {
    const accessToken = await token(ctx)
    const res = await apiGet<{ filter?: GmailFilter[] }>(accessToken, '/settings/filters')
    return (res.filter ?? []).map(toFilterRecord)
  },

  async getFilter(ctx: ChannelContext, id: string): Promise<FilterRecord> {
    const accessToken = await token(ctx)
    const f = await apiGet<GmailFilter>(
      accessToken,
      `/settings/filters/${encodeURIComponent(id)}`
    )
    return toFilterRecord(f)
  },

  // NOTE: no updateFilter — the Gmail API has no filter update endpoint
  // (delete + recreate is the supported pattern). The serve layer returns 405.

  async deleteFilter(ctx: ChannelContext, id: string): Promise<void> {
    const accessToken = await token(ctx)
    await apiDelete(accessToken, `/settings/filters/${encodeURIComponent(id)}`)
  },

  sendAvailability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async sendMessage(
    ctx: ChannelContext,
    recipient: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    const accessToken = await token(ctx)
    const from = ctx.auth.user
    const raw = opts?.html
      ? buildHtmlRaw(recipient, from, opts.subject ?? splitSubject(text).subject, {
          // Plaintext alternative: an explicit body if the caller passed one,
          // else a readable text rendering of the HTML.
          text: text.trim() ? splitSubject(text).body : htmlToText(opts.html),
          html: opts.html,
        })
      : buildPlainRaw(recipient, from, ...subjectBody(text, opts?.subject))
    const res = await fetch(`${API_BASE}/messages/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Gmail send failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
    }
  },
}

/**
 * Let callers pass an explicit subject by starting the text with a
 * `Subject: ...` line followed by a blank line; otherwise default the subject
 * and treat the whole text as the body.
 */
export function splitSubject(text: string): { subject: string; body: string } {
  const m = text.match(/^Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/)
  if (m) return { subject: m[1].trim(), body: m[2] }
  return { subject: '(no subject)', body: text }
}

/**
 * Resolve subject + body from a text blob and an optional explicit subject.
 * An explicit subject wins and the whole text is treated as the body (no
 * `Subject:` line stripping); otherwise fall back to splitSubject.
 */
function subjectBody(text: string, subject?: string): [string, string] {
  if (subject != null) return [subject, text]
  const s = splitSubject(text)
  return [s.subject, s.body]
}

/** Encode a UTF-8 string as base64 wrapped at 76 chars (RFC 2045). */
function b64Wrapped(s: string): string {
  return (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

/** Build a plain-text RFC822 message, base64url-encoded for the Gmail API. */
function buildPlainRaw(
  recipient: string,
  from: string | undefined,
  subject: string,
  body: string
): string {
  const headers = [
    `To: ${recipient}`,
    from ? `From: ${from}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ]
    .filter(Boolean)
    .join('\r\n')
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

/**
 * Build a multipart/alternative RFC822 message (text/plain + text/html),
 * base64url-encoded for the Gmail API. Each part body is base64-encoded so
 * long HTML lines never trip the SMTP 998-char line limit.
 */
function buildHtmlRaw(
  recipient: string,
  from: string | undefined,
  subject: string,
  parts: { text: string; html: string }
): string {
  const boundary = `=_snazi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const headers = [
    `To: ${recipient}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter((l): l is string => l !== null)
  const lines = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Wrapped(parts.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Wrapped(parts.html),
    `--${boundary}--`,
  ].join('\r\n')
  return Buffer.from(lines, 'utf8').toString('base64url')
}
