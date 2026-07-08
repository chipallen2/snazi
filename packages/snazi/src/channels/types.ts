/**
 * Channel adapter contract.
 *
 * A ChannelAdapter is the LOCAL message SOURCE for one medium (iMessage today;
 * Gmail/Outlook/etc. later). It answers two questions for the gate:
 *   - WHO messaged recently (`listInboundSenders`) — never content.
 *   - WHAT one (already-approved) sender said (`readMessagesFrom`).
 *
 * Adapters also declare which OS platforms they can run on and self-report
 * availability, so a channel that can't run here (e.g. iMessage on Windows)
 * degrades to a clear message instead of a crash. The approval gate (api.ts)
 * and the server list are channel-agnostic and live OUTSIDE this contract —
 * adapters only provide the local source of messages, never the decision.
 */

// Canonical row shapes live in chatdb.ts (the first adapter). They are the
// channel-neutral types every adapter speaks. `import type` / `export type`
// are erased at runtime, so this module pulls in no native dependency.
import type { SenderSummary, MessageRow } from '../chatdb'
import type { ChannelAuth } from '../config'
export type { SenderSummary, MessageRow }

export interface ChannelAvailability {
  available: boolean
  /** Why the channel can't be read here (shown to the user) when unavailable. */
  reason?: string
  /** Optional extra hint, e.g. how to grant Full Disk Access. */
  detail?: string
}

/**
 * Per-call context identifying WHICH channel instance an adapter is acting for.
 * One adapter (e.g. the gmail adapter) serves every gmail instance; the context
 * carries that instance's id/name and its LOCAL credentials so "Personal" and
 * "Work" gmail read different mailboxes. Credentials never leave this machine.
 */
/** Supported action ids for performMessageAction */
export type MessageAction = 'archive' | 'delete' | 'markRead' | 'markUnread'

export interface MessageActionParams {
  /** Apply action to all messages from this sender (in the given window). */
  sender?: string
  /** Apply action to a single message by adapter-native id. */
  messageId?: string
  /** How far back to look when using sender-based targeting (default 1440 min = 24h). */
  sinceMinutes?: number
}

export interface MessageActionResult {
  affected: number
}

/**
 * Simplified, provider-neutral action kinds for a mail FILTER/RULE. Adapters
 * translate these to their native shape (Gmail label ops / Graph rule actions).
 */
export type FilterActionKind =
  | 'delete'
  | 'archive'
  | 'label'
  | 'markRead'
  | 'forward'

/**
 * A filter/rule spec. Callers may use the SIMPLIFIED fields (from/to/subject/
 * query + action) which each adapter maps to its native model, OR pass a RAW
 * provider-native `criteria`/`actions` object to bypass translation entirely.
 * Raw fields, when present, take precedence over the simplified ones.
 */
export interface FilterSpec {
  /** Match: sender address (Gmail `from`; Outlook senderContains). */
  from?: string
  /** Match: recipient address (Gmail `to`; Outlook recipientContains). */
  to?: string
  /** Match: subject substring. */
  subject?: string
  /** Match: Gmail raw search query (Gmail only). */
  query?: string
  /** Simplified action to take on matching mail. */
  action?: FilterActionKind
  /** Gmail label id to add when action is 'label'. */
  labelId?: string
  /** Address to forward matching mail to (action 'forward'). */
  forwardTo?: string
  /** Outlook destination folder id/well-known name for 'archive'/move. */
  folderId?: string
  /** Optional human display name (Outlook rules require one; auto-generated otherwise). */
  name?: string
  /** Raw provider-native criteria/conditions (bypasses simplified mapping). */
  criteria?: Record<string, unknown>
  /** Raw provider-native actions (bypasses simplified mapping). */
  actions?: Record<string, unknown>
}

/** A created/listed filter or rule, provider-neutral on the outside. */
export interface FilterRecord {
  /** Adapter-native id (Gmail filter id / Graph messageRule id). */
  id: string
  /** One-line human summary for CLI display. */
  summary: string
  /** Provider-native object (Gmail filter / Graph messageRule). */
  raw: unknown
}

/**
 * Optional extras for {@link ChannelAdapter.sendMessage}. All fields are
 * optional so the plain-text send path (text-only) is unchanged.
 */
export interface SendOptions {
  /** Email subject. Takes precedence over any `Subject:` line in the body. */
  subject?: string
  /** HTML body. When set, email channels send an HTML message. */
  html?: string
  /**
   * Override the From address (email channels only). Requires the sending
   * account to have this address configured as a verified "send mail as"
   * alias; otherwise the provider rejects or rewrites it. When omitted, the
   * account's own address (ctx.auth.user) is used.
   */
  from?: string
  /**
   * Native id of the message being replied to (email channels only). When set,
   * the adapter sends a REAL threaded reply: Gmail builds In-Reply-To/
   * References headers and sets the original threadId; Outlook uses Graph's
   * native reply endpoints. When omitted, a brand-new message is sent (which
   * does NOT thread in the recipient's client). Get this id from a read row's
   * `id` field - usually the latest incoming message.
   */
  replyToMessageId?: string
  /**
   * When replying, also address everyone on the original To + Cc (minus the
   * sending account's own address). Ignored unless `replyToMessageId` is set.
   */
  replyAll?: boolean
}

export interface ChannelContext {
  /** Instance slug (the `--channel` value), e.g. 'gmail-work'. */
  id: string
  /** Channel type, e.g. 'gmail'. Selects this adapter. */
  type: string
  /** Human-readable instance name, e.g. 'Work'. */
  name: string
  /** Local-only credentials for this instance (empty for imessage). */
  auth: ChannelAuth
}

/** One calendar available on a channel instance (e.g. a named Outlook calendar). */
export interface CalendarInfo {
  /** Adapter-native calendar id (Graph calendar id). */
  id: string
  /** Human display name, e.g. "Calendar", "Vacation". */
  name: string
  /** True if this is the account's default calendar. */
  isDefault?: boolean
}

/**
 * Provider-neutral request to create a calendar event. Adapters translate this
 * to their native shape and own any all-day date-math quirks internally (e.g.
 * Microsoft Graph requires an EXCLUSIVE end date for all-day events — the
 * caller always supplies an INCLUSIVE last day here; the adapter adds the
 * day-after conversion itself).
 */
export interface CalendarEventSpec {
  /** Adapter-native calendar id to create the event on (resolved from a name upstream). */
  calendarId: string
  /** Event title. */
  subject: string
  /**
   * Start. For an all-day event: date-only "YYYY-MM-DD". For a timed event:
   * a full ISO 8601 datetime.
   */
  start: string
  /**
   * End (INCLUSIVE last day for all-day events). Optional — defaults to
   * `start` (a single day / instant). For a timed event: a full ISO 8601
   * datetime.
   */
  end?: string
  /** True for an all-day event (or multi-day all-day range); false for timed. */
  allDay: boolean
  /** IANA timezone for a timed event, or the timezone Graph stores an all-day event under. Defaults to 'UTC'. */
  timeZone?: string
}

/** A created calendar event, provider-neutral on the outside. */
export interface CalendarEventRecord {
  /** Adapter-native event id. */
  id: string
  subject: string
  /** Adapter-native start dateTime actually sent to the provider. */
  start: string
  /** Adapter-native end dateTime actually sent to the provider (exclusive day-after for all-day). */
  end: string
  allDay: boolean
  /** Provider-native created object. */
  raw: unknown
}

export interface ChannelAdapter {
  /** Stable TYPE id used in config + the server registry (e.g. 'imessage'). */
  id: string
  /** Human-readable type name (e.g. 'iMessage'). */
  displayName: string
  /**
   * `process.platform` values this adapter can read on (e.g. ['darwin']).
   * An empty array means "any platform".
   */
  platforms: NodeJS.Platform[]
  /** Can this channel instance actually be read on THIS machine right now? */
  availability(ctx?: ChannelContext): ChannelAvailability
  /** Distinct inbound senders in the window — WHO only, never content. */
  listInboundSenders(
    ctx: ChannelContext,
    sinceMinutes: number
  ): Promise<SenderSummary[]>
  /** Messages for ONE sender. Caller MUST have verified approval first. */
  readMessagesFrom(
    ctx: ChannelContext,
    sender: string,
    sinceMinutes: number
  ): Promise<MessageRow[]>
  /**
   * Can this channel instance send outbound messages on THIS machine right now?
   * Omit when the channel has no send path.
   */
  sendAvailability?(ctx?: ChannelContext): ChannelAvailability
  /**
   * Send a message to a recipient. NEVER gated by the approval list — the
   * soup nazi only blocks reading. Throws on failure.
   *
   * `text` is always the plaintext body (and, for email, the plaintext
   * alternative). `opts.html`, when present, upgrades email channels to send a
   * multipart/alternative (Gmail) or HTML-body (Outlook) message; non-email
   * channels ignore it and send `text`. `opts.subject`, when present, is the
   * email subject (and takes precedence over any `Subject:` line in `text`).
   */
  sendMessage?(
    ctx: ChannelContext,
    recipient: string,
    text: string,
    opts?: SendOptions
  ): Promise<void>
  /**
   * Perform an action on one or more messages. NEVER gated — actions don't
   * require sender approval. Throws on failure.
   */
  performMessageAction?(
    ctx: ChannelContext,
    action: MessageAction,
    params: MessageActionParams
  ): Promise<MessageActionResult>
  /**
   * Can this channel instance manage server-side filters/rules on THIS machine?
   * Omit when the channel has no filter API (e.g. iMessage).
   */
  filterAvailability?(ctx?: ChannelContext): ChannelAvailability
  /** Create a filter/rule from a (simplified or raw) spec. Throws on failure. */
  createFilter?(ctx: ChannelContext, spec: FilterSpec): Promise<FilterRecord>
  /** List all filters/rules for this instance. Throws on failure. */
  listFilters?(ctx: ChannelContext): Promise<FilterRecord[]>
  /** Get one filter/rule by adapter-native id. Throws on failure. */
  getFilter?(ctx: ChannelContext, id: string): Promise<FilterRecord>
  /**
   * Update a filter/rule in place. Present only where the provider supports it
   * (Outlook). Gmail has no update API — omit it there (server returns 405).
   */
  updateFilter?(ctx: ChannelContext, id: string, spec: FilterSpec): Promise<FilterRecord>
  /** Delete a filter/rule by adapter-native id. Throws on failure. */
  deleteFilter?(ctx: ChannelContext, id: string): Promise<void>
  /**
   * Can this channel instance manage CALENDAR events on THIS machine?
   * Omit when the channel has no calendar API (e.g. iMessage).
   */
  calendarAvailability?(ctx?: ChannelContext): ChannelAvailability
  /** List calendars (id + name) available on this instance. Throws on failure. */
  listCalendars?(ctx: ChannelContext): Promise<CalendarInfo[]>
  /**
   * Create a calendar event. NEVER gated — calendar writes are fully open,
   * unlike capability adapters such as Schwab. Throws on failure.
   */
  createCalendarEvent?(
    ctx: ChannelContext,
    spec: CalendarEventSpec
  ): Promise<CalendarEventRecord>
}
