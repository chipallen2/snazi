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
  CalendarEventRecord,
  CalendarEventSpec,
  CalendarInfo,
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

/** PATCH that parses and returns the updated JSON resource. */
async function graphPatchJson<T>(
  accessToken: string,
  url: string,
  body: unknown
): Promise<T> {
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
  return res.json().catch(() => ({})) as Promise<T>
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

const RULES_PATH = '/me/mailFolders/inbox/messageRules'

interface GraphRuleActions {
  moveToFolder?: string
  delete?: boolean
  markAsRead?: boolean
  assignCategories?: string[]
  forwardTo?: GraphRecipient[]
  redirectTo?: GraphRecipient[]
}
interface GraphRuleConditions {
  senderContains?: string[]
  subjectContains?: string[]
  bodyContains?: string[]
  recipientContains?: string[]
  fromAddresses?: GraphRecipient[]
}
interface GraphMessageRule {
  id?: string
  displayName?: string
  sequence?: number
  isEnabled?: boolean
  conditions?: GraphRuleConditions
  actions?: GraphRuleActions
}

/** Build Graph rule conditions from the simplified spec (undefined if none). */
function toGraphConditions(spec: FilterSpec): GraphRuleConditions | undefined {
  if (spec.criteria) return spec.criteria as GraphRuleConditions
  const c: GraphRuleConditions = {}
  if (spec.from) c.senderContains = [spec.from]
  if (spec.to) c.recipientContains = [spec.to]
  if (spec.subject) c.subjectContains = [spec.subject]
  return Object.keys(c).length ? c : undefined
}

/** Build Graph rule actions from the simplified spec (undefined if no action). */
function toGraphActions(spec: FilterSpec): GraphRuleActions | undefined {
  if (spec.actions) return spec.actions as GraphRuleActions
  if (!spec.action) return undefined
  switch (spec.action) {
    case 'delete':
      return { delete: true }
    case 'archive':
      return { moveToFolder: spec.folderId || 'archive' }
    case 'markRead':
      return { markAsRead: true }
    case 'label':
      if (!spec.labelId) throw new Error("Outlook 'label' action requires --label-id (category name).")
      return { assignCategories: [spec.labelId] }
    case 'forward':
      if (!spec.forwardTo) throw new Error("Outlook 'forward' action requires --forward-to.")
      return { forwardTo: [{ emailAddress: { address: spec.forwardTo } }] }
    default:
      throw new Error(
        `Outlook rule needs an action: delete | archive | markRead | label | forward.`
      )
  }
}

/** Auto-generate a display name for a rule when the caller didn't supply one. */
function defaultRuleName(spec: FilterSpec): string {
  const bits: string[] = []
  if (spec.action) bits.push(spec.action)
  if (spec.from) bits.push(`from ${spec.from}`)
  else if (spec.subject) bits.push(`subject ${spec.subject}`)
  else if (spec.to) bits.push(`to ${spec.to}`)
  return `snazi: ${bits.join(' ') || 'rule'}`.slice(0, 64)
}

function ruleSummary(r: GraphMessageRule): string {
  const c = r.conditions ?? {}
  const match: string[] = []
  if (c.senderContains?.length) match.push(`from~${c.senderContains.join('|')}`)
  if (c.subjectContains?.length) match.push(`subject~${c.subjectContains.join('|')}`)
  if (c.bodyContains?.length) match.push(`body~${c.bodyContains.join('|')}`)
  if (c.recipientContains?.length) match.push(`to~${c.recipientContains.join('|')}`)
  if (c.fromAddresses?.length)
    match.push(`from=${c.fromAddresses.map((a) => a.emailAddress?.address).join('|')}`)
  const a = r.actions ?? {}
  const acts: string[] = []
  if (a.delete) acts.push('delete')
  if (a.moveToFolder) acts.push(`move:${a.moveToFolder}`)
  if (a.markAsRead) acts.push('markRead')
  if (a.assignCategories?.length) acts.push(`label:${a.assignCategories.join('+')}`)
  if (a.forwardTo?.length)
    acts.push(`forward:${a.forwardTo.map((x) => x.emailAddress?.address).join(',')}`)
  if (a.redirectTo?.length)
    acts.push(`redirect:${a.redirectTo.map((x) => x.emailAddress?.address).join(',')}`)
  const name = r.displayName ? `"${r.displayName}" ` : ''
  return `${name}[${match.join(', ') || '(any)'}] -> ${acts.join(', ') || '(no action)'}`
}

function toRuleRecord(r: GraphMessageRule): FilterRecord {
  return { id: r.id ?? '', summary: ruleSummary(r), raw: r }
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
    // Native Graph message id: the value to pass back as --reply-to.
    id: m.id,
    from_me: !incoming,
    direction: incoming ? 'incoming' : 'outgoing',
  }
}

interface GraphCalendar {
  id?: string
  name?: string
  isDefaultCalendar?: boolean
}

interface GraphDateTimeTz {
  dateTime?: string
  timeZone?: string
}

interface GraphEvent {
  id?: string
  subject?: string
  isAllDay?: boolean
  start?: GraphDateTimeTz
  end?: GraphDateTimeTz
}

const DEFAULT_EVENT_TZ = 'UTC'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Add `days` calendar days to a "YYYY-MM-DD" string (UTC-safe, no local TZ drift). */
function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Build the Graph start/end dateTime pair for an event.
 *
 * All-day quirk: Graph requires `isAllDay:true` events to carry date-only
 * dateTime values (midnight, matching timeZone on both ends) AND the `end`
 * date must be the day AFTER the last inclusive day — a single-day all-day
 * event from 2026-07-20 to 2026-07-20 (inclusive) must be submitted as
 * start=2026-07-20T00:00:00 / end=2026-07-21T00:00:00, or Graph creates a
 * ZERO-length (invisible) event. This function owns that conversion so
 * callers always pass the INCLUSIVE last day.
 */
function buildGraphEventTimes(spec: CalendarEventSpec): {
  start: GraphDateTimeTz
  end: GraphDateTimeTz
} {
  const tz = spec.timeZone?.trim() || DEFAULT_EVENT_TZ
  if (spec.allDay) {
    const startDate = spec.start.slice(0, 10)
    if (!DATE_ONLY_RE.test(startDate)) {
      throw new Error(`Invalid all-day start date '${spec.start}'. Use YYYY-MM-DD.`)
    }
    const inclusiveEndDate = (spec.end?.slice(0, 10) || startDate)
    if (!DATE_ONLY_RE.test(inclusiveEndDate)) {
      throw new Error(`Invalid all-day end date '${spec.end}'. Use YYYY-MM-DD.`)
    }
    // Graph wants the EXCLUSIVE end (day after the last inclusive day).
    const exclusiveEndDate = addDaysToDateStr(inclusiveEndDate, 1)
    return {
      start: { dateTime: `${startDate}T00:00:00`, timeZone: tz },
      end: { dateTime: `${exclusiveEndDate}T00:00:00`, timeZone: tz },
    }
  }
  // Timed event: pass the caller's ISO datetimes through as-is.
  const start = spec.start
  const end = spec.end || spec.start
  return {
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  }
}

function toCalendarInfo(c: GraphCalendar): CalendarInfo {
  return {
    id: c.id ?? '',
    name: c.name ?? '(unnamed)',
    ...(c.isDefaultCalendar ? { isDefault: true } : {}),
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
    const select = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,body,bodyPreview'

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
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    const accessToken = await token(ctx)

    // Reply path: Microsoft Graph has NATIVE reply endpoints that handle
    // subject, threading, and quoting automatically, so we don't reconstruct
    // any headers like Gmail. `comment` accepts plain text or HTML.
    // NOTE / known limitation: Graph's /reply and /replyAll do NOT honor a From
    // override, so `--from` is ignored on a reply. We prefer threading the reply
    // correctly over honoring the alias, rather than silently dropping the
    // reply-to id.
    if (opts?.replyToMessageId) {
      const enc = encodeURIComponent(opts.replyToMessageId)
      const endpoint = opts.replyAll ? 'replyAll' : 'reply'
      const comment = opts.html ?? text
      await graphPost(accessToken, `${GRAPH}/me/messages/${enc}/${endpoint}`, { comment })
      return
    }

    // Forward path: Microsoft Graph has a NATIVE /forward endpoint that keeps
    // the original message + its attachments intact, so (unlike Gmail) we
    // don't reconstruct any MIME ourselves. `comment` is the caller's optional
    // note, shown above the forwarded original in the recipient's client.
    // Same From-override limitation as reply: Graph's /forward doesn't accept
    // a from override, so `--from` is ignored on a forward too.
    if (opts?.forwardMessageId) {
      const enc = encodeURIComponent(opts.forwardMessageId)
      await graphPost(accessToken, `${GRAPH}/me/messages/${enc}/forward`, {
        comment: opts.html ?? text ?? '',
        toRecipients: [{ emailAddress: { address: recipient } }],
      })
      return
    }

    // A verified send-as alias may override the From address.
    const fromAddr = opts?.from ?? ctx.auth.user
    // Explicit subject wins; otherwise fall back to a `Subject:` line in text.
    const parsed = splitSubject(text)
    const subject = opts?.subject ?? parsed.subject
    const bodyPayload = opts?.html
      ? { contentType: 'HTML', content: opts.html }
      : { contentType: 'Text', content: opts?.subject != null ? text : parsed.body }
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: bodyPayload,
          toRecipients: [{ emailAddress: { address: recipient } }],
          ...(fromAddr ? { from: { emailAddress: { address: fromAddr } } } : {}),
        },
        saveToSentItems: true,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Outlook send failed: HTTP ${res.status} ${errBody.slice(0, 200)}`)
    }
  },

  filterAvailability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  async createFilter(ctx: ChannelContext, spec: FilterSpec): Promise<FilterRecord> {
    const accessToken = await token(ctx)
    const conditions = toGraphConditions(spec)
    const actions = toGraphActions(spec)
    if (!actions || Object.keys(actions).length === 0) {
      throw new Error('Outlook rule requires at least one action.')
    }
    if (!conditions || Object.keys(conditions).length === 0) {
      throw new Error('Outlook rule requires at least one condition (from, to, or subject).')
    }
    // sequence must be present on create; pick one past the current max so the
    // new rule runs last and never collides with an existing sequence.
    const existing = await graphGet<{ value?: GraphMessageRule[] }>(
      accessToken,
      `${GRAPH}${RULES_PATH}`
    )
    const maxSeq = (existing.value ?? []).reduce(
      (m, r) => Math.max(m, Number(r.sequence) || 0),
      0
    )
    const rule: GraphMessageRule = {
      displayName: spec.name || defaultRuleName(spec),
      sequence: maxSeq + 1,
      isEnabled: true,
      conditions,
      actions,
    }
    const created = await graphPost<GraphMessageRule>(accessToken, `${GRAPH}${RULES_PATH}`, rule)
    return toRuleRecord(created)
  },

  async listFilters(ctx: ChannelContext): Promise<FilterRecord[]> {
    const accessToken = await token(ctx)
    const res = await graphGet<{ value?: GraphMessageRule[] }>(
      accessToken,
      `${GRAPH}${RULES_PATH}`
    )
    return (res.value ?? []).map(toRuleRecord)
  },

  async getFilter(ctx: ChannelContext, id: string): Promise<FilterRecord> {
    const accessToken = await token(ctx)
    const r = await graphGet<GraphMessageRule>(
      accessToken,
      `${GRAPH}${RULES_PATH}/${encodeURIComponent(id)}`
    )
    return toRuleRecord(r)
  },

  async updateFilter(ctx: ChannelContext, id: string, spec: FilterSpec): Promise<FilterRecord> {
    const accessToken = await token(ctx)
    // Partial PATCH: only send the properties the caller actually specified so
    // an action-only update doesn't wipe the rule's conditions (and vice-versa).
    const patch: GraphMessageRule = {}
    const conditions = toGraphConditions(spec)
    const actions = toGraphActions(spec)
    if (conditions) patch.conditions = conditions
    if (actions) patch.actions = actions
    if (spec.name) patch.displayName = spec.name
    if (Object.keys(patch).length === 0) {
      throw new Error('Nothing to update: provide a match (from/to/subject), an action, or a name.')
    }
    const url = `${GRAPH}${RULES_PATH}/${encodeURIComponent(id)}`
    const updated = await graphPatchJson<GraphMessageRule>(accessToken, url, patch)
    // Graph may return an empty body on PATCH; fall back to a fresh GET.
    if (updated && updated.id) return toRuleRecord(updated)
    const fresh = await graphGet<GraphMessageRule>(accessToken, url)
    return toRuleRecord(fresh)
  },

  async deleteFilter(ctx: ChannelContext, id: string): Promise<void> {
    const accessToken = await token(ctx)
    await graphDelete(accessToken, `${GRAPH}${RULES_PATH}/${encodeURIComponent(id)}`)
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

  calendarAvailability(ctx?: ChannelContext): ChannelAvailability {
    return oauthAvailability(ctx, LABEL)
  },

  /**
   * List calendars available on this account (GET /me/calendars). Used to
   * resolve a human calendar name (e.g. "Vacation") to its Graph id before
   * creating an event on it.
   */
  async listCalendars(ctx: ChannelContext): Promise<CalendarInfo[]> {
    const accessToken = await token(ctx)
    const url = graphUrl('/me/calendars', {
      $select: 'id,name,isDefaultCalendar',
      $top: '100',
    })
    const res = await graphGet<{ value?: GraphCalendar[] }>(accessToken, url)
    return (res.value ?? []).map(toCalendarInfo)
  },

  /**
   * Create a calendar event (POST /me/calendars/{id}/events). NEVER gated —
   * calendar writes are fully open (unlike Schwab-style capability actions).
   * Handles the Graph all-day exclusive-end-date quirk internally; callers
   * always pass the INCLUSIVE last day.
   */
  async createCalendarEvent(
    ctx: ChannelContext,
    spec: CalendarEventSpec
  ): Promise<CalendarEventRecord> {
    const accessToken = await token(ctx)
    const { start, end } = buildGraphEventTimes(spec)
    const enc = encodeURIComponent(spec.calendarId)
    const body = {
      subject: spec.subject,
      isAllDay: spec.allDay,
      start,
      end,
    }
    const created = await graphPost<GraphEvent>(
      accessToken,
      `${GRAPH}/me/calendars/${enc}/events`,
      body
    )
    return {
      id: created.id ?? '',
      subject: created.subject ?? spec.subject,
      start: created.start?.dateTime ?? start.dateTime ?? '',
      end: created.end?.dateTime ?? end.dateTime ?? '',
      allDay: created.isAllDay ?? spec.allDay,
      raw: created,
    }
  },
}
