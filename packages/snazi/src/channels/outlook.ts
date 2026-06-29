/**
 * Outlook / Microsoft 365 channel adapter (Microsoft Graph over HTTPS, OAuth2).
 *
 * Cross-platform (pure HTTPS via global fetch). Acts for ONE configured instance
 * via the ChannelContext, whose `auth` holds that instance's OAuth2 credentials
 * (clientId, clientSecret, refreshToken, optional tenantId). Credentials live
 * ONLY in the local config and are never sent to the snazi server.
 *
 * Maps the channel contract onto Graph:
 *   - listInboundSenders -> recent inbox senders (From addresses) + counts
 *   - readMessagesFrom   -> mail to/from one address (both directions)
 *   - sendMessage        -> send a plain-text email (never gated)
 *
 * The refresh token needs offline_access + Mail.Read + Mail.Send.
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
import { htmlToText, oauthAvailability, requireOAuth } from './mail'
import { splitSubject } from './gmail'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const LABEL = 'Outlook'
const MAX_LIST = 100
const MAX_READ = 50
const MAX_BODY_CHARS = 20_000

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string }
}
interface GraphMessage {
  id: string
  subject?: string
  from?: GraphRecipient
  toRecipients?: GraphRecipient[]
  receivedDateTime?: string
  sentDateTime?: string
  body?: { contentType?: string; content?: string }
  bodyPreview?: string
}

async function token(ctx: ChannelContext): Promise<string> {
  const { clientId, clientSecret, refreshToken } = requireOAuth(ctx, LABEL)
  const tenant = ctx.auth.tenantId?.trim() || 'common'
  return getAccessToken({
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId,
    clientSecret,
    refreshToken,
    // Omit scope by default so the refresh INHERITS the scopes already consented
    // (e.g. an n8n token's Mail.ReadWrite + Mail.Send). Override via auth.scope.
    scope: ctx.auth.scope,
  })
}

/** Build a Graph URL, percent-encoding OData query values (spaces -> %20). */
function graphUrl(path: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `${GRAPH}${path}${qs ? `?${qs}` : ''}`
}

async function graphGet<T>(accessToken: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Graph GET failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

async function graphPost<T>(
  accessToken: string,
  url: string,
  body: unknown
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Graph POST failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
  }
  return res.json().catch(() => ({})) as Promise<T>
}

async function graphPatch(accessToken: string, url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Graph PATCH failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
  }
}

async function graphDelete(accessToken: string, url: string): Promise<void> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Graph DELETE failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
  }
}

/** Perform one Graph action on a single message id. */
async function actOnMessage(
  accessToken: string,
  action: MessageAction,
  id: string
): Promise<void> {
  const enc = encodeURIComponent(id)
  switch (action) {
    case 'archive':
      await graphPost(accessToken, `${GRAPH}/me/messages/${enc}/move`, {
        destinationId: 'archive',
      })
      return
    case 'delete':
      await graphDelete(accessToken, `${GRAPH}/me/messages/${enc}`)
      return
    case 'markRead':
      await graphPatch(accessToken, `${GRAPH}/me/messages/${enc}`, { isRead: true })
      return
    case 'markUnread':
      await graphPatch(accessToken, `${GRAPH}/me/messages/${enc}`, { isRead: false })
      return
    default:
      throw new Error(`Unsupported action: ${String(action)}`)
  }
}

function isoSince(sinceMinutes: number): string {
  return new Date(Date.now() - sinceMinutes * 60_000).toISOString()
}

/** Escape a value for an OData string literal (single quotes are doubled). */
function odataString(v: string): string {
  return v.replace(/'/g, "''")
}

function bodyText(m: GraphMessage): string {
  const content = m.body?.content ?? ''
  const text =
    (m.body?.contentType ?? '').toLowerCase() === 'html'
      ? htmlToText(content)
      : content.trim()
  return (text || m.bodyPreview || '').slice(0, MAX_BODY_CHARS)
}

function rowFrom(m: GraphMessage, incoming: boolean): MessageRow {
  const subject = (m.subject ?? '').trim()
  const body = bodyText(m)
  const text = subject ? `${subject}\n\n${body}`.trim() : body
  const when = m.receivedDateTime || m.sentDateTime || ''
  const d = when ? new Date(when) : new Date(0)
  return {
    date: d.toISOString(),
    text,
    from_me: !incoming,
    direction: incoming ? 'incoming' : 'outgoing',
  }
}

export const outlookAdapter: ChannelAdapter = {
  id: 'outlook',
  displayName: 'Outlook',
  platforms: [], // any platform: pure HTTPS

  availability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async listInboundSenders(
    ctx: ChannelContext,
    sinceMinutes: number
  ): Promise<SenderSummary[]> {
    const accessToken = await token(ctx)
    const url = graphUrl('/me/mailFolders/inbox/messages', {
      $select: 'from,receivedDateTime',
      $top: String(MAX_LIST),
      $filter: `receivedDateTime ge ${isoSince(sinceMinutes)}`,
      $orderby: 'receivedDateTime desc',
    })
    const res = await graphGet<{ value?: GraphMessage[] }>(accessToken, url)
    const bySender = new Map<string, { count: number; latest: number }>()
    for (const m of res.value ?? []) {
      const addr = (m.from?.emailAddress?.address ?? '').toLowerCase()
      if (!addr) continue
      const ts = m.receivedDateTime ? Date.parse(m.receivedDateTime) : 0
      const cur = bySender.get(addr)
      if (cur) {
        cur.count += 1
        if (ts > cur.latest) cur.latest = ts
      } else {
        bySender.set(addr, { count: 1, latest: ts })
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
    const since = isoSince(sinceMinutes)
    const select = 'subject,from,toRecipients,receivedDateTime,sentDateTime,body,bodyPreview'

    // Incoming: messages from this address (server-side filter).
    const inboundUrl = graphUrl('/me/messages', {
      $select: select,
      $top: String(MAX_READ),
      $filter: `receivedDateTime ge ${since} and from/emailAddress/address eq '${odataString(addr)}'`,
      $orderby: 'receivedDateTime desc',
    })
    // Outgoing: recent sent items, filtered to this recipient client-side
    // (recipient lambda filters are unreliable on Graph).
    const sentUrl = graphUrl('/me/mailFolders/sentitems/messages', {
      $select: select,
      $top: String(MAX_READ),
      $filter: `sentDateTime ge ${since}`,
      $orderby: 'sentDateTime desc',
    })

    const [inbound, sent] = await Promise.all([
      graphGet<{ value?: GraphMessage[] }>(accessToken, inboundUrl),
      graphGet<{ value?: GraphMessage[] }>(accessToken, sentUrl).catch(() => ({ value: [] })),
    ])

    const rows: MessageRow[] = []
    for (const m of inbound.value ?? []) rows.push(rowFrom(m, true))
    for (const m of sent.value ?? []) {
      const toThem = (m.toRecipients ?? []).some(
        (r) => (r.emailAddress?.address ?? '').toLowerCase() === addr
      )
      if (toThem) rows.push(rowFrom(m, false))
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date))
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
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: [{ emailAddress: { address: recipient } }],
          ...(ctx.auth.user ? { from: { emailAddress: { address: ctx.auth.user } } } : {}),
        },
        saveToSentItems: true,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Outlook send failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
    }
  },

  async performMessageAction(
    ctx: ChannelContext,
    action: MessageAction,
    params: MessageActionParams
  ): Promise<MessageActionResult> {
    const accessToken = await token(ctx)

    // Single-message targeting: act directly on the given id.
    if (params.messageId) {
      await actOnMessage(accessToken, action, params.messageId)
      return { affected: 1 }
    }

    // Sender targeting: fetch matching inbox message ids, then act on each.
    if (params.sender) {
      const addr = params.sender.toLowerCase()
      const since = isoSince(params.sinceMinutes ?? 1440)
      // No $orderby — Graph rejects filter-on-from + orderby-on-receivedDateTime.
      const url = graphUrl('/me/mailFolders/inbox/messages', {
        $select: 'id,from,receivedDateTime',
        $top: String(MAX_LIST),
        $filter: `from/emailAddress/address eq '${odataString(addr)}' and receivedDateTime ge ${since}`,
      })
      const res = await graphGet<{ value?: GraphMessage[] }>(accessToken, url)
      const ids = (res.value ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
      let affected = 0
      const errors: string[] = []
      for (const id of ids) {
        try {
          await actOnMessage(accessToken, action, id)
          affected += 1
        } catch (e) {
          errors.push(String(e instanceof Error ? e.message : e))
        }
      }
      // Surface partial failures but don't throw if at least some succeeded.
      if (errors.length > 0 && affected === 0) {
        throw new Error(`All ${errors.length} action(s) failed. First: ${errors[0]}`)
      }
      return { affected, ...(errors.length ? { failed: errors.length } : {}) } as MessageActionResult
    }

    throw new Error('performMessageAction requires either sender or messageId.')
  },
}
