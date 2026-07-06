import Database from 'better-sqlite3'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const DEFAULT_CHAT_DB = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db'
)

/**
 * Resolve the chat.db path. Honors the `SNAZI_CHAT_DB` env var (if set and
 * non-empty) so tests can point at a synthetic DB; otherwise the real
 * ~/Library/Messages/chat.db. Read per-call so tests can set/unset freely.
 */
function getChatDbPath(): string {
  const override = process.env.SNAZI_CHAT_DB
  if (override && override.trim() !== '') return override
  return DEFAULT_CHAT_DB
}

// Apple Cocoa epoch: 2001-01-01 in unix seconds.
const APPLE_EPOCH = 978307200

/** Convert a unix-ms cutoff into Apple's nanosecond `message.date` units. */
export function unixMsToAppleNs(unixMs: number): number {
  return Math.floor((unixMs / 1000 - APPLE_EPOCH) * 1e9)
}

/** Convert Apple's `message.date` (ns) back into a JS Date. */
export function appleNsToDate(appleNs: number): Date {
  return new Date((appleNs / 1e9 + APPLE_EPOCH) * 1000)
}

export interface SenderSummary {
  sender: string
  message_count: number
  latest_at: string
}

export interface MessageRow {
  date: string
  text: string
  /**
   * Native provider message id (e.g. the Gmail/Outlook message id). This is
   * the value a caller passes back as `--reply-to` to send a REAL threaded
   * reply. Optional because not every channel exposes one (iMessage leaves it
   * undefined). Almost always the LATEST incoming row is the one to reply to.
   */
  id?: string
  /** True when the message was sent by the user (outbound), false when received. */
  from_me: boolean
  /** Human-friendly direction tag mirroring `from_me`. */
  direction: 'incoming' | 'outgoing'
}

function openDb(): Database.Database {
  const chatDb = getChatDbPath()
  if (!fs.existsSync(chatDb)) {
    throw new Error(
      `chat.db not found at ${chatDb}. Is this a Mac with Messages?`
    )
  }
  try {
    return new Database(chatDb, { readonly: true, fileMustExist: true })
  } catch (e) {
    throw new Error(
      `Cannot open chat.db (${String(
        e
      )}). Grant your terminal Full Disk Access in System Settings > Privacy & Security.`
    )
  }
}

/** The resolved chat.db path (honors SNAZI_CHAT_DB). Exposed for diagnostics. */
export function chatDbPath(): string {
  return getChatDbPath()
}

/**
 * Non-throwing readability probe used by the iMessage channel adapter's
 * availability check. Returns `{ ok: true }` only if chat.db exists AND can be
 * opened + queried read-only (i.e. Full Disk Access is granted). Otherwise
 * returns a human-readable reason — never throws.
 */
export function probeChatDb(): { ok: boolean; reason?: string } {
  const chatDb = getChatDbPath()
  if (!fs.existsSync(chatDb)) {
    return { ok: false, reason: `chat.db not found at ${chatDb}.` }
  }
  let db: Database.Database | undefined
  try {
    db = new Database(chatDb, { readonly: true, fileMustExist: true })
    // A trivial query forces the file open: this is what fails without FDA.
    db.prepare('SELECT 1').get()
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      reason: `Cannot open chat.db at ${chatDb} (likely missing Full Disk Access): ${String(
        e instanceof Error ? e.message : e
      )}`,
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors on a probe
    }
  }
}

// A 1:1 (direct) conversation is a chat with exactly ONE participant in
// chat_handle_join. Group chats have 2+. We scope BOTH listing and reading to
// these so "approve a person" means "their DMs" — never their group-chat
// traffic. This also avoids leaking who's in your group threads.
const DIRECT_CHATS_SQL = `
  SELECT chat_id FROM chat_handle_join
  GROUP BY chat_id HAVING COUNT(*) = 1
`

/**
 * Return distinct INBOUND senders in the window — WHO only, never WHAT.
 * Scoped to 1:1 conversations (group chats are excluded).
 * `sinceMinutes` is the lookback window in minutes.
 */
export function listInboundSenders(sinceMinutes: number): SenderSummary[] {
  const cutoffNs = unixMsToAppleNs(Date.now() - sinceMinutes * 60_000)
  const db = openDb()
  try {
    const rows = db
      .prepare(
        `SELECT h.id AS sender, COUNT(*) AS cnt, MAX(m.date) AS latest
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE m.is_from_me = 0 AND m.date > ?
           AND cmj.chat_id IN (${DIRECT_CHATS_SQL})
         GROUP BY h.id
         ORDER BY latest DESC`
      )
      .all(cutoffNs) as { sender: string; cnt: number; latest: number }[]

    return rows.map((r) => ({
      sender: r.sender,
      message_count: r.cnt,
      latest_at: appleNsToDate(r.latest).toISOString(),
    }))
  } finally {
    db.close()
  }
}

/**
 * Return actual message TEXT for ONE sender's 1:1 conversation in the window —
 * BOTH directions (the sender's inbound messages AND the user's outbound replies),
 * in chronological order, each tagged with its direction.
 *
 * Scoping is by CHAT, not by handle_id: we find the 1:1 chat(s) whose sole
 * participant is `sender`, then return every message in those chats. This is
 * deliberate — in a real chat.db, OUTBOUND messages have handle_id = 0 (they
 * are NOT tagged with the recipient's handle), so a handle-only join would
 * silently drop the user's own replies. Joining via the chat captures both sides
 * correctly and keeps group-chat traffic out.
 *
 * Caller MUST have verified the sender is approved before calling this.
 */
export function readMessagesFrom(
  sender: string,
  sinceMinutes: number
): MessageRow[] {
  const cutoffNs = unixMsToAppleNs(Date.now() - sinceMinutes * 60_000)
  const db = openDb()
  try {
    const rows = db
      .prepare(
        `SELECT m.date AS date, m.text AS text, m.is_from_me AS is_from_me
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id IN (
                 SELECT chj.chat_id
                 FROM chat_handle_join chj
                 JOIN handle h ON h.ROWID = chj.handle_id
                 WHERE chj.chat_id IN (${DIRECT_CHATS_SQL})
                   AND h.id = ?
               )
           AND m.date > ? AND m.text IS NOT NULL
         ORDER BY m.date ASC`
      )
      .all(sender, cutoffNs) as {
      date: number
      text: string
      is_from_me: number
    }[]

    return rows.map((r) => {
      const fromMe = r.is_from_me === 1
      return {
        date: appleNsToDate(r.date).toISOString(),
        text: r.text,
        from_me: fromMe,
        direction: fromMe ? ('outgoing' as const) : ('incoming' as const),
      }
    })
  } finally {
    db.close()
  }
}
