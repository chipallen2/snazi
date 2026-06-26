#!/usr/bin/env node
/**
 * Serve-level test for macOS Contacts enrichment + the HARD security invariant:
 *
 *   contact_name is DISPLAY-ONLY. A sender that is `denied`/`unknown` STILL gets
 *   a contact_name on /list-new and /check, but /read STILL returns 403 — a
 *   known Contacts name must NEVER open the gate.
 *
 * Strategy (no prod, all synthetic):
 *   - synthetic chat.db (SNAZI_CHAT_DB) with two inbound DM senders,
 *   - synthetic AddressBook (SNAZI_ADDRESSBOOK_DB) naming BOTH of them,
 *   - a mock web /api/senders + /api/senders/check that marks one DENIED and
 *     the other UNKNOWN (neither approved),
 *   - assert /list-new + /check carry contact_name for the non-approved senders,
 *     /resolve carries contact_name, and /read => 403 for the denied sender.
 *
 * Adapter-dependent routes (/list-new, /read) need the iMessage adapter, which
 * is macOS-only. On non-darwin we skip just those and still assert /check +
 * /resolve enrichment.
 *
 * Run:  npm run build && node test/serve-contacts.test.cjs
 * Exits nonzero on failure.
 */
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const IS_DARWIN = process.platform === 'darwin'

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// --- Apple chat.db date helper (mirror chatdb.ts) --------------------------
const APPLE_EPOCH = 978307200
const appleNs = (unixMs) => Math.floor((unixMs / 1000 - APPLE_EPOCH) * 1e9)

const DENIED = '+17606721109' // known in Contacts, status denied
const UNKNOWN = '+14155550000' // known in Contacts, status unknown
const NONAME = '+13235550000' // approved-but-no-contact (contact_name null)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snazi-serve-contacts-'))

// --- Build synthetic chat.db -----------------------------------------------
const chatDbPath = path.join(tmpDir, 'chat.db')
{
  const db = new Database(chatDbPath)
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, handle_id INTEGER, text TEXT,
      date INTEGER, is_from_me INTEGER
    );
  `)
  const senders = [DENIED, UNKNOWN, NONAME]
  const insH = db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)')
  const insC = db.prepare('INSERT INTO chat (ROWID) VALUES (?)')
  const linkH = db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)')
  const insM = db.prepare('INSERT INTO message (handle_id, text, date, is_from_me) VALUES (?, ?, ?, ?)')
  const linkM = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)')
  const now = Date.now()
  senders.forEach((s, i) => {
    const h = i + 1
    const c = (i + 1) * 10
    insH.run(h, s)
    insC.run(c)
    linkH.run(c, h) // 1 participant -> direct DM
    const id = insM.run(h, `hi from ${s}`, appleNs(now - 5 * 60_000), 0).lastInsertRowid
    linkM.run(c, id)
  })
  db.close()
}

// --- Build synthetic AddressBook -------------------------------------------
const abDbPath = path.join(tmpDir, 'AddressBook-v22.abcddb')
{
  const db = new Database(abDbPath)
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `)
  const rec = db.prepare('INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (?, ?, ?, ?, ?)')
  const ph = db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)')
  rec.run(1, 'Jenny', 'Tutone', null, null)
  ph.run(1, '(760) 672-1109') // formatted -> +17606721109 (DENIED)
  rec.run(2, 'Coach', 'Steve', null, null)
  ph.run(2, '415-555-0000') // no CC -> last-10 match +14155550000 (UNKNOWN)
  // NONAME deliberately absent from Contacts.
  db.close()
}

// --- Mock web /api/senders surface -----------------------------------------
const STATUS_BY_ADDR = {
  [DENIED]: 'denied',
  [UNKNOWN]: 'unknown',
  [NONAME]: 'approved',
}
// /resolve pulls the labelled sender list; give the non-approved ones labels so
// they appear, to prove contact_name rides alongside label there too.
const SENDER_LIST = [
  { channel_id: 'imessage', sender_address: DENIED, label: 'Blocked Caller', status: 'denied' },
  { channel_id: 'imessage', sender_address: NONAME, label: 'Approved Friend', status: 'approved' },
]

const webApi = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.headers['x-api-key'] !== 'READ_KEY') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'unauthorized' }))
  }
  if (req.method === 'GET' && url.pathname === '/api/senders/check') {
    const addr = url.searchParams.get('address') || ''
    const status = STATUS_BY_ADDR[addr] ?? 'unknown'
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status }))
  }
  if (req.method === 'GET' && url.pathname === '/api/senders') {
    const ch = url.searchParams.get('channel')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ senders: SENDER_LIST.filter((s) => s.channel_id === ch) }))
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

const TOKEN = 'serve-bearer-token-xyz'

function req(server, { method = 'GET', path: p, token, body }) {
  return new Promise((resolve) => {
    const addr = server.address()
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    let payload
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const r = http.request({ host: addr.address, port: addr.port, method, path: p, headers }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => {
        let json
        try {
          json = JSON.parse(s)
        } catch {
          json = { _raw: s }
        }
        resolve({ status: res.statusCode, json })
      })
    })
    r.on('error', (e) => resolve({ status: 0, json: { error: String(e.code || e.message) } }))
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}

async function main() {
  // Point the gate at the synthetic DBs and disable the status cache so each
  // check goes straight to the mock.
  process.env.SNAZI_CHAT_DB = chatDbPath
  process.env.SNAZI_ADDRESSBOOK_DB = abDbPath
  process.env.SNAZI_CHECK_CACHE_TTL_MS = '0'
  process.env.SNAZI_CACHE_FILE = path.join(tmpDir, 'cache.json')
  delete process.env.SNAZI_ADDRESSBOOK_DIR
  delete process.env.SNAZI_DEFAULT_COUNTRY_CODE

  const { createServer } = require('../dist/server.js')

  await new Promise((res) => webApi.listen(0, '127.0.0.1', res))
  const apiPort = webApi.address().port
  const cfg = {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    apiKey: 'READ_KEY',
    serveToken: TOKEN,
    channels: ['imessage'],
  }
  const serve = createServer(cfg)
  await new Promise((res) => serve.listen(0, '127.0.0.1', res))

  // --- /check: DENIED sender STILL gets contact_name (display-only) ---
  let r = await req(serve, { path: `/check?sender=${encodeURIComponent(DENIED)}&channel=imessage`, token: TOKEN })
  check(r.status === 200, '/check 200 for denied sender')
  check(r.json.status === 'denied', '/check reports status=denied (gate stays shut)')
  check(r.json.contact_name === 'Jenny Tutone', '/check enriches DENIED sender with contact_name')
  check('contact_name' in r.json && 'label' in r.json, '/check keeps contact_name AND label as separate fields')

  // --- /check: UNKNOWN sender, last-10 Contacts match ---
  r = await req(serve, { path: `/check?sender=${encodeURIComponent(UNKNOWN)}&channel=imessage`, token: TOKEN })
  check(r.json.status === 'unknown' && r.json.contact_name === 'Coach Steve', '/check enriches UNKNOWN sender (last-10 match)')

  // --- /check: approved sender NOT in Contacts -> contact_name null ---
  r = await req(serve, { path: `/check?sender=${encodeURIComponent(NONAME)}&channel=imessage`, token: TOKEN })
  check(r.json.status === 'approved' && r.json.contact_name === null, '/check contact_name null when not in Contacts')

  // --- /resolve carries contact_name alongside label ---
  r = await req(serve, { path: '/resolve?name=&channel=imessage', token: TOKEN })
  check(r.status === 200 && Array.isArray(r.json.matches), '/resolve 200 with matches')
  {
    const denied = r.json.matches.find((m) => m.sender_address === DENIED)
    const approved = r.json.matches.find((m) => m.sender_address === NONAME)
    check(denied && denied.contact_name === 'Jenny Tutone' && denied.label === 'Blocked Caller',
      '/resolve carries BOTH label and contact_name (separate) for denied sender')
    check(approved && approved.contact_name === null,
      '/resolve contact_name null when sender not in Contacts')
  }

  // --- THE HARD INVARIANT: contact_name does NOT open the gate ---
  if (IS_DARWIN) {
    r = await req(serve, { path: `/read?sender=${encodeURIComponent(DENIED)}&channel=imessage&since=60`, token: TOKEN })
    check(r.status === 403, 'INVARIANT: /read on DENIED sender -> 403 EVEN THOUGH contact_name is known')
    check(r.json.status === 'denied' && !JSON.stringify(r.json).includes('hi from'),
      '/read 403 leaks NO message text for denied sender')

    r = await req(serve, { path: `/read?sender=${encodeURIComponent(UNKNOWN)}&channel=imessage&since=60`, token: TOKEN })
    check(r.status === 403, 'INVARIANT: /read on UNKNOWN sender -> 403 (contact name does not gate)')

    // approved sender CAN read, and the 200 response carries contact_name=null here.
    r = await req(serve, { path: `/read?sender=${encodeURIComponent(NONAME)}&channel=imessage&since=60`, token: TOKEN })
    check(r.status === 200, '/read on APPROVED sender -> 200 (gate opens on status only)')
    check('contact_name' in r.json, '/read 200 includes contact_name field')

    // --- /list-new: enriches EVERY sender regardless of status ---
    r = await req(serve, { path: '/list-new?channel=imessage&since=60', token: TOKEN })
    check(r.status === 200 && Array.isArray(r.json.senders), '/list-new 200 with senders')
    const byAddr = Object.fromEntries(r.json.senders.map((s) => [s.sender, s]))
    check(byAddr[DENIED] && byAddr[DENIED].contact_name === 'Jenny Tutone' && byAddr[DENIED].status === 'denied',
      '/list-new: DENIED sender carries contact_name (display-only, gate stays denied)')
    check(byAddr[UNKNOWN] && byAddr[UNKNOWN].contact_name === 'Coach Steve',
      '/list-new: UNKNOWN sender carries contact_name (last-10 match)')
    check(byAddr[NONAME] && byAddr[NONAME].contact_name === null,
      '/list-new: sender absent from Contacts -> contact_name null')
    check(r.json.senders.every((s) => 'label' in s && 'contact_name' in s),
      '/list-new: label and contact_name BOTH present as separate fields')
  } else {
    console.log('  SKIP: /read + /list-new (iMessage adapter is macOS-only; this host is ' + process.platform + ')')
  }

  await new Promise((res) => serve.close(res))
  await new Promise((res) => webApi.close(res))
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
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
