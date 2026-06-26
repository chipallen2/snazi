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
export type { SenderSummary, MessageRow }

export interface ChannelAvailability {
  available: boolean
  /** Why the channel can't be read here (shown to the user) when unavailable. */
  reason?: string
  /** Optional extra hint, e.g. how to grant Full Disk Access. */
  detail?: string
}

export interface ChannelAdapter {
  /** Stable id used in config + the server list (e.g. 'imessage'). */
  id: string
  /** Human-readable name (e.g. 'iMessage'). */
  displayName: string
  /**
   * `process.platform` values this adapter can read on (e.g. ['darwin']).
   * An empty array means "any platform".
   */
  platforms: NodeJS.Platform[]
  /** Can this channel actually be read on THIS machine right now? */
  availability(): ChannelAvailability
  /** Distinct inbound senders in the window — WHO only, never content. */
  listInboundSenders(sinceMinutes: number): SenderSummary[]
  /** Messages for ONE sender. Caller MUST have verified approval first. */
  readMessagesFrom(sender: string, sinceMinutes: number): MessageRow[]
}
