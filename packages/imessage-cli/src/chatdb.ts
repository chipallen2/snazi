import Database from 'better-sqlite3'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const CHAT_DB = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db'
)

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
}

function openDb(): Database.Database {
  if (!fs.existsSync(CHAT_DB)) {
    throw new Error(
      `chat.db not found at ${CHAT_DB}. Is this a Mac with Messages?`
    )
  }
  try {
    return new Database(CHAT_DB, { readonly: true, fileMustExist: true })
  } catch (e) {
    throw new Error(
      `Cannot open chat.db (${String(
        e
      )}). Grant your terminal Full Disk Access in System Settings > Privacy & Security.`
    )
  }
}

/**
 * Return distinct INBOUND senders in the window — WHO only, never WHAT.
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
         WHERE m.is_from_me = 0 AND m.date > ?
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
 * Return actual message TEXT for ONE sender in the window.
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
        `SELECT m.date AS date, m.text AS text
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.is_from_me = 0 AND h.id = ? AND m.date > ? AND m.text IS NOT NULL
         ORDER BY m.date ASC`
      )
      .all(sender, cutoffNs) as { date: number; text: string }[]

    return rows.map((r) => ({
      date: appleNsToDate(r.date).toISOString(),
      text: r.text,
    }))
  } finally {
    db.close()
  }
}
