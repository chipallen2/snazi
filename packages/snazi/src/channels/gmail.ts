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
  MessageAction,
  MessageActionParams,
  MessageActionResult,
  MessageRow,
  SenderSummary,
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

  sendAvailability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async sendMessage(
    ctx: ChannelContext,
    recipient: string,
    text: string
  ): Promise<void> {
    const accessToken = await token(ctx)
    const { subject, body } = splitSubject(text)
    const from = ctx.auth.user
    const headers = [
      `To: ${recipient}`,
      from ? `From: ${from}` : '',
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
    ]
      .filter(Boolean)
      .join('\r\n')
    const raw = Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8').toString('base64url')
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
