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
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id: string
  threadId?: string
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
        // Native Gmail message id: the value to pass back as --reply-to.
        id: m.id,
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
    // A verified "send mail as" alias may override the From address; otherwise
    // fall back to the account's own address.
    const from = opts?.from ?? ctx.auth.user

    // Forward path: build a REAL MIME forward (Fwd: subject + quoted original
    // headers/body + re-attached original attachments), a brand-new thread.
    // Reply path: build RFC 5322 threading headers from the original message
    // and set threadId so Gmail actually threads the reply. Kept SEPARATE from
    // the new-message path below so a plain send stays byte-identical.
    const sendBody: { raw: string; threadId?: string } = opts?.forwardMessageId
      ? await buildForwardBody(accessToken, recipient, from, text, opts)
      : opts?.replyToMessageId
      ? await buildReplyBody(accessToken, recipient, from, text, opts)
      : {
          raw: opts?.html
            ? buildHtmlRaw(recipient, from, opts.subject ?? splitSubject(text).subject, {
                // Plaintext alternative: an explicit body if the caller passed one,
                // else a readable text rendering of the HTML.
                text: text.trim() ? splitSubject(text).body : htmlToText(opts.html),
                html: opts.html,
              })
            : buildPlainRaw(recipient, from, ...subjectBody(text, opts?.subject)),
        }
    const res = await fetch(`${API_BASE}/messages/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(sendBody),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Gmail send failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
    }
  },
}

/**
 * Add a single `Fwd: ` prefix to a subject, without doubling up when it
 * already starts with one (case-insensitive). An empty subject becomes `Fwd:`.
 */
function forwardSubject(origSubject: string): string {
  const s = (origSubject ?? '').trim()
  if (/^fwd:/i.test(s)) return s
  return s ? `Fwd: ${s}` : 'Fwd:'
}

/**
 * Recursively collect real attachment parts (a filename + an attachmentId to
 * fetch the bytes separately) from a Gmail payload tree, skipping inline
 * text/html body parts which have `body.data` but no `attachmentId`.
 */
function collectAttachmentParts(payload?: GmailPart): GmailPart[] {
  if (!payload) return []
  const result: GmailPart[] = []
  const walk = (p: GmailPart): void => {
    if (p.filename && p.body?.attachmentId) result.push(p)
    for (const child of p.parts ?? []) walk(child)
  }
  walk(payload)
  return result
}

/**
 * Build the Gmail /messages/send body for a REAL forward: fetches the
 * original message (headers + body + attachment refs), prefixes the subject
 * with a single `Fwd:`, renders a standard "Forwarded message" header block
 * plus the original body below the caller's optional comment, and re-attaches
 * the original attachments best-effort (fetched individually and re-encoded).
 * Unlike a reply, a forward starts a brand-new thread — no `threadId` is set.
 */
async function buildForwardBody(
  accessToken: string,
  recipient: string,
  from: string | undefined,
  text: string,
  opts: SendOptions
): Promise<{ raw: string; threadId?: string }> {
  const messageId = opts.forwardMessageId as string
  const orig = await apiGet<GmailMessage>(accessToken, `/messages/${encodeURIComponent(messageId)}`, {
    format: 'full',
  })
  const origSubject = headerValue(orig, 'Subject')
  const origFrom = headerValue(orig, 'From')
  const origDate = headerValue(orig, 'Date')
  const origTo = headerValue(orig, 'To')
  const subject = opts.subject ?? forwardSubject(origSubject)
  const origBody = extractBody(orig.payload)

  const forwardedHeader = [
    '---------- Forwarded message ---------',
    origFrom ? `From: ${origFrom}` : '',
    origDate ? `Date: ${origDate}` : '',
    origSubject ? `Subject: ${origSubject}` : '',
    origTo ? `To: ${origTo}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  // The caller's comment (--text) goes above the quoted original. An explicit
  // --subject means text is the whole comment as-is; otherwise strip a
  // possible `Subject:` line the same way a plain send would.
  const comment = (opts.subject != null ? text : splitSubject(text).body).trim()
  const bodyText = [comment, '', forwardedHeader, '', origBody].join('\n')

  // Best-effort attachment re-attachment: fetch each attachment's bytes and
  // rebuild them as MIME parts. A single fetch failure drops that one
  // attachment rather than failing the whole forward.
  const attachmentSpecs = collectAttachmentParts(orig.payload)
  const attachments = (
    await Promise.all(
      attachmentSpecs.map(async (part) => {
        const attId = part.body?.attachmentId
        if (!attId) return null
        try {
          const att = await apiGet<{ data?: string; size?: number }>(
            accessToken,
            `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}`
          )
          if (!att.data) return null
          const base64 = Buffer.from(att.data, 'base64url').toString('base64')
          return {
            filename: part.filename || 'attachment',
            mimeType: part.mimeType || 'application/octet-stream',
            base64,
          }
        } catch {
          return null
        }
      })
    )
  ).filter((a): a is { filename: string; mimeType: string; base64: string } => a !== null)

  const raw =
    attachments.length > 0
      ? buildForwardMixedRaw(recipient, from, subject, bodyText, attachments)
      : buildPlainRaw(recipient, from, subject, bodyText)

  // No threadId: a forward starts a new thread, unlike a reply.
  return { raw }
}

/**
 * Build a multipart/mixed RFC822 forward message: a text/plain part (the
 * comment + quoted forwarded original) followed by one part per re-attached
 * original attachment, base64url-encoded for the Gmail API.
 */
function buildForwardMixedRaw(
  recipient: string,
  from: string | undefined,
  subject: string,
  bodyText: string,
  attachments: { filename: string; mimeType: string; base64: string }[]
): string {
  const boundary = `=_snazi_fwd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const headers = [
    `To: ${recipient}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter((l): l is string => l !== null)
  const lines: string[] = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Wrapped(bodyText),
  ]
  for (const att of attachments) {
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`)
    lines.push('Content-Transfer-Encoding: base64')
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`)
    lines.push('')
    lines.push((att.base64.match(/.{1,76}/g) ?? []).join('\r\n'))
  }
  lines.push(`--${boundary}--`)
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

/**
 * Parse a comma-separated address-list header (To/Cc) into bare, lowercased
 * emails, dropping any that don't parse. Handles `"Name" <a@b>, c@d` forms.
 */
function parseAddressList(header: string): string[] {
  if (!header || !header.trim()) return []
  return header
    .split(',')
    .map((part) => extractEmail(part))
    .filter((a): a is string => Boolean(a))
}

/**
 * Add a single `Re: ` prefix to a subject, without doubling up when it already
 * starts with one (case-insensitive). An empty subject becomes `Re:`.
 */
function replySubject(origSubject: string): string {
  const s = (origSubject ?? '').trim()
  if (/^re:/i.test(s)) return s
  return s ? `Re: ${s}` : 'Re:'
}

/**
 * Build the Gmail /messages/send body for a REAL threaded reply. Fetches the
 * original message's threading metadata, derives In-Reply-To / References /
 * Subject, optionally CCs everyone (reply-all, minus our own addresses), and
 * returns `{ raw, threadId }` so Gmail threads it in the recipient's client.
 */
async function buildReplyBody(
  accessToken: string,
  recipient: string,
  from: string | undefined,
  text: string,
  opts: SendOptions
): Promise<{ raw: string; threadId?: string }> {
  const orig = await apiGet<GmailMessage>(
    accessToken,
    `/messages/${encodeURIComponent(opts.replyToMessageId as string)}`,
    {
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'To', 'Cc'],
    }
  )
  const origMessageId = headerValue(orig, 'Message-ID')
  const origReferences = headerValue(orig, 'References')
  const origSubject = headerValue(orig, 'Subject')

  // Explicit --subject wins; otherwise reuse the original with one Re: prefix.
  const subject = opts.subject ?? replySubject(origSubject)

  // Standard RFC 5322 threading: References = prior References + this Message-ID.
  const references = [origReferences, origMessageId]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ')

  // reply-all: CC original To + Cc, minus our own address(es) and the primary
  // recipient (which stays whatever the caller passed).
  let cc: string[] = []
  if (opts.replyAll) {
    const own = new Set(
      [from, recipient].filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase())
    )
    const everyone = [
      ...parseAddressList(headerValue(orig, 'To')),
      ...parseAddressList(headerValue(orig, 'Cc')),
    ]
    const seen = new Set<string>()
    cc = everyone.filter((a) => {
      if (own.has(a) || seen.has(a)) return false
      seen.add(a)
      return true
    })
  }

  const threadHeaders: Record<string, string> = {}
  if (origMessageId) threadHeaders['In-Reply-To'] = origMessageId
  if (references) threadHeaders['References'] = references
  if (cc.length) threadHeaders['Cc'] = cc.join(', ')

  const raw = opts.html
    ? buildHtmlRaw(
        recipient,
        from,
        subject,
        {
          text: text.trim() ? splitSubject(text).body : htmlToText(opts.html),
          html: opts.html,
        },
        threadHeaders
      )
    : buildPlainRaw(
        recipient,
        from,
        subject,
        opts.subject != null ? text : splitSubject(text).body,
        threadHeaders
      )
  return { raw, threadId: orig.threadId }
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

/**
 * Build a plain-text RFC822 message, base64url-encoded for the Gmail API.
 * `extra` carries optional threading headers (In-Reply-To/References/Cc) for a
 * reply; omitted for a normal send so the output stays unchanged.
 */
function buildPlainRaw(
  recipient: string,
  from: string | undefined,
  subject: string,
  body: string,
  extra?: Record<string, string>
): string {
  const headers = [
    `To: ${recipient}`,
    from ? `From: ${from}` : '',
    `Subject: ${subject}`,
    ...extraHeaderLines(extra),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ]
    .filter(Boolean)
    .join('\r\n')
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

/** Render optional extra headers as `Name: value` lines (empty list when none). */
function extraHeaderLines(extra?: Record<string, string>): string[] {
  if (!extra) return []
  return Object.entries(extra)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
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
  parts: { text: string; html: string },
  extra?: Record<string, string>
): string {
  const boundary = `=_snazi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const headers = [
    `To: ${recipient}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    ...extraHeaderLines(extra),
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
