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
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
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

  const ins = db.prepare(
    'INSERT INTO message (handle_id, text, date, is_from_me) VALUES (?, ?, ?, ?)'
  )
  // Within window (last 60 min), interleaved inbound/outbound, inserted OUT of
  // chronological order to prove the ORDER BY date ASC works.
  ins.run(hSender, 'inbound-2 (20m ago)', min(20), 0)
  ins.run(hSender, 'outbound-1 (40m ago)', min(40), 1)
  ins.run(hSender, 'inbound-1 (50m ago)', min(50), 0)
  ins.run(hSender, 'outbound-2 (10m ago)', min(10), 1)
  // Outside the 60-min window: must be excluded.
  ins.run(hSender, 'inbound-old (120m ago)', min(120), 0)
  ins.run(hSender, 'outbound-old (90m ago)', min(90), 1)
  // NULL text within window: must be excluded.
  ins.run(hSender, null, min(5), 0)
  // Different handle within window: must be excluded.
  ins.run(hOther, 'other-handle inbound (15m ago)', min(15), 0)
  ins.run(hOther, 'other-handle outbound (15m ago)', min(15), 1)
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
