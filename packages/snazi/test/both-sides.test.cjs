#!/usr/bin/env node
/**
 * Standalone test for chatdb.readMessagesFrom returning BOTH sides of a
 * conversation (inbound + outbound), chronologically ordered, correctly
 * tagged, with other handles excluded and the sinceMinutes window respected.
 *
 * Run:  npm run build && node test/both-sides.test.cjs
 * Exits nonzero on failure.
 */
const Database = require('better-sqlite3')
const os = require('os')
const path = require('path')
const fs = require('fs')

// --- Apple chat.db date helpers (mirror chatdb.ts) -------------------------
const APPLE_EPOCH = 978307200
function unixMsToAppleNs(unixMs) {
  return Math.floor((unixMs / 1000 - APPLE_EPOCH) * 1e9)
}

let failures = 0
function check(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`)
  } else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// --- Build a synthetic chat.db --------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snazi-bothsides-'))
const dbPath = path.join(tmpDir, 'chat.db')

const SENDER = '+15551112222'
const OTHER = '+15559998888'

const now = Date.now()
const min = (m) => unixMsToAppleNs(now - m * 60_000)

{
  const db = new Database(dbPath)
  // Mirror the REAL chat.db structure we depend on: conversations live in
  // `chat`, linked to messages via `chat_message_join` and to participants via
  // `chat_handle_join`. Crucially, OUTBOUND messages have handle_id = 0 (they
  // are NOT tagged with the recipient's handle) — exactly like macOS.
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      handle_id INTEGER,
      text TEXT,
      date INTEGER,
      is_from_me INTEGER
    );
  `)
  const hSender = 1
  const hOther = 2
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(hSender, SENDER)
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(hOther, OTHER)

  // Chats: 10 = direct w/ SENDER, 20 = direct w/ OTHER, 30 = group (both).
  const cDirectSender = 10
  const cDirectOther = 20
  const cGroup = 30
  for (const c of [cDirectSender, cDirectOther, cGroup]) {
    db.prepare('INSERT INTO chat (ROWID) VALUES (?)').run(c)
  }
  const linkHandle = db.prepare(
    'INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)'
  )
  linkHandle.run(cDirectSender, hSender) // 1 participant -> direct
  linkHandle.run(cDirectOther, hOther) // 1 participant -> direct
  linkHandle.run(cGroup, hSender) // 2 participants -> group
  linkHandle.run(cGroup, hOther)

  const ins = db.prepare(
    'INSERT INTO message (handle_id, text, date, is_from_me) VALUES (?, ?, ?, ?)'
  )
  const linkMsg = db.prepare(
    'INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)'
  )
  // Insert a message into a given chat. Outbound (is_from_me=1) uses handle_id
  // 0 to match how macOS actually stores the user's own outbound replies.
  function msg(chat, text, dateNs, fromMe) {
    const handleId = fromMe ? 0 : (chat === cDirectOther ? hOther : hSender)
    const id = ins.run(handleId, text, dateNs, fromMe).lastInsertRowid
    linkMsg.run(chat, id)
  }

  // Direct chat with SENDER — within window, interleaved, inserted OUT of
  // chronological order to prove ORDER BY date ASC. Outbound has handle_id 0.
  msg(cDirectSender, 'inbound-2 (20m ago)', min(20), 0)
  msg(cDirectSender, 'outbound-1 (40m ago)', min(40), 1)
  msg(cDirectSender, 'inbound-1 (50m ago)', min(50), 0)
  msg(cDirectSender, 'outbound-2 (10m ago)', min(10), 1)
  // Outside the 60-min window: must be excluded.
  msg(cDirectSender, 'inbound-old (120m ago)', min(120), 0)
  msg(cDirectSender, 'outbound-old (90m ago)', min(90), 1)
  // NULL text within window: must be excluded.
  msg(cDirectSender, null, min(5), 0)
  // Different handle's DIRECT chat within window: must be excluded.
  msg(cDirectOther, 'other-handle inbound (15m ago)', min(15), 0)
  msg(cDirectOther, 'other-handle outbound (15m ago)', min(15), 1)
  // GROUP chat containing SENDER within window: must be excluded (not a DM).
  msg(cGroup, 'group-chat from sender (15m ago)', min(15), 0)
  msg(cGroup, 'group-chat reply (15m ago)', min(15), 1)
  db.close()
}

// --- Point chatdb at the synthetic DB and exercise it ----------------------
process.env.SNAZI_CHAT_DB = dbPath
const { readMessagesFrom } = require('../dist/chatdb.js')

console.log('both-sides.test: reading 60-min window for', SENDER)
const rows = readMessagesFrom(SENDER, 60)

console.log('  returned:', JSON.stringify(rows, null, 2))

// --- Assertions ------------------------------------------------------------
// 4 in-window, non-null, same-handle rows expected.
check(rows.length === 4, `exactly 4 rows returned (got ${rows.length})`)

const texts = rows.map((r) => r.text)
// Chronological order ASC: 50m, 40m, 20m, 10m ago.
check(
  JSON.stringify(texts) ===
    JSON.stringify([
      'inbound-1 (50m ago)',
      'outbound-1 (40m ago)',
      'inbound-2 (20m ago)',
      'outbound-2 (10m ago)',
    ]),
  'rows are in chronological (date ASC) order'
)

// Both directions present.
check(
  rows.some((r) => r.from_me === false) && rows.some((r) => r.from_me === true),
  'both inbound (from_me=false) and outbound (from_me=true) present'
)

// Direction tags correct and consistent with from_me.
check(
  rows.every(
    (r) =>
      r.direction === (r.from_me ? 'outgoing' : 'incoming') &&
      (r.direction === 'incoming' || r.direction === 'outgoing')
  ),
  'direction tag matches from_me for every row'
)

// Specific tagging.
const byText = Object.fromEntries(rows.map((r) => [r.text, r]))
check(
  byText['inbound-1 (50m ago)'].direction === 'incoming' &&
    byText['inbound-1 (50m ago)'].from_me === false,
  'inbound row tagged incoming/from_me=false'
)
check(
  byText['outbound-1 (40m ago)'].direction === 'outgoing' &&
    byText['outbound-1 (40m ago)'].from_me === true,
  'outbound row tagged outgoing/from_me=true'
)

// Other handle excluded (neither direction).
check(
  !texts.some((t) => t.startsWith('other-handle')),
  "other handle's messages excluded"
)

// Group-chat messages excluded even though SENDER is a participant — read is
// scoped to the 1:1 DM, never group threads.
check(
  !texts.some((t) => t.startsWith('group-chat')),
  'group-chat messages excluded (1:1 scoping)'
)

// Window respected: old messages excluded.
check(
  !texts.includes('inbound-old (120m ago)') &&
    !texts.includes('outbound-old (90m ago)'),
  'messages outside sinceMinutes window excluded (both directions)'
)

// NULL text excluded.
check(
  rows.every((r) => r.text != null),
  'NULL-text rows excluded'
)

// `date` field still present and ISO-formatted.
check(
  rows.every((r) => typeof r.date === 'string' && !Number.isNaN(Date.parse(r.date))),
  'date field present and ISO-parseable'
)

// --- Cleanup + verdict -----------------------------------------------------
try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {}

if (failures === 0) {
  console.log('\nRESULT: PASS')
  process.exit(0)
} else {
  console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
