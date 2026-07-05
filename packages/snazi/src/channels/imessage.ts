/**
 * iMessage channel adapter (macOS only).
 *
 * Wraps chatdb.ts. The chatdb module is loaded LAZILY (via require inside each
 * method) so that importing the channel registry on a non-macOS host never
 * pulls in better-sqlite3 (a native module) or touches
 * ~/Library/Messages/chat.db. On any non-darwin platform this adapter reports
 * itself unavailable with a clear reason instead of throwing a cryptic native
 * or SQLite error.
 */
import type {
  ChannelAdapter,
  ChannelAvailability,
  ChannelContext,
  SenderSummary,
  MessageRow,
  SendOptions,
} from './types'

const FDA_HINT =
  'Grant Full Disk Access to your terminal (or the node binary) in ' +
  'System Settings > Privacy & Security > Full Disk Access, then retry.'

// Lazy require: only load chatdb (and thus better-sqlite3) when we actually
// read on macOS. Keeps Windows/Linux installs free of the native dependency at
// runtime — they never reach this code because availability() returns first.
function chatdb(): typeof import('../chatdb') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../chatdb')
}

export const imessageAdapter: ChannelAdapter = {
  id: 'imessage',
  displayName: 'iMessage',
  platforms: ['darwin'],

  // iMessage reads the local Messages DB, so it ignores the per-instance ctx.
  availability(_ctx?: ChannelContext): ChannelAvailability {
    if (process.platform !== 'darwin') {
      return {
        available: false,
        reason: `iMessage can only be read on macOS (this host is ${process.platform}).`,
      }
    }
    let probe: { ok: boolean; reason?: string }
    try {
      probe = chatdb().probeChatDb()
    } catch (e) {
      // better-sqlite3 is an optional native dependency; if it failed to
      // install (or load), report it cleanly instead of throwing.
      return {
        available: false,
        reason: `iMessage backend unavailable: ${String(
          e instanceof Error ? e.message : e
        )}`,
        detail:
          'Reinstall to build the native better-sqlite3 module (needs Xcode Command Line Tools).',
      }
    }
    if (probe.ok) return { available: true }
    return { available: false, reason: probe.reason, detail: FDA_HINT }
  },

  async listInboundSenders(
    _ctx: ChannelContext,
    sinceMinutes: number
  ): Promise<SenderSummary[]> {
    return chatdb().listInboundSenders(sinceMinutes)
  },

  async readMessagesFrom(
    _ctx: ChannelContext,
    sender: string,
    sinceMinutes: number
  ): Promise<MessageRow[]> {
    return chatdb().readMessagesFrom(sender, sinceMinutes)
  },

  sendAvailability(_ctx?: ChannelContext): ChannelAvailability {
    // Lazy require keeps non-macOS installs free of send-side deps at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const send = require('../imessage-send') as typeof import('../imessage-send')
    return send.probeSendAvailability()
  },

  async sendMessage(
    _ctx: ChannelContext,
    recipient: string,
    text: string,
    _opts?: SendOptions
  ): Promise<void> {
    // iMessage is text-only: HTML (_opts.html) is intentionally ignored; the
    // caller always passes a plaintext `text` fallback.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const send = require('../imessage-send') as typeof import('../imessage-send')
    send.sendIMessage(recipient, text)
  },
}
