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
   */
  sendMessage?(ctx: ChannelContext, recipient: string, text: string): Promise<void>
  /**
   * Perform an action on one or more messages. NEVER gated — actions don't
   * require sender approval. Throws on failure.
   */
  performMessageAction?(
    ctx: ChannelContext,
    action: MessageAction,
    params: MessageActionParams
  ): Promise<MessageActionResult>
}
