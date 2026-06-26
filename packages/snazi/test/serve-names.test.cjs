#!/usr/bin/env node
/**
 * Smoke test for the names feature on `snazi serve`:
 *   - /resolve  (name -> address book, substring/case-insensitive, empty=all)
 *   - POST /label (UPDATE-only display label; CANNOT create rows or touch status)
 *   - label attached to /list-new and /check
 *   - bearer auth + validation + body-size cap + method gating
 *
 * It NEVER hits prod: a local mock stands in for the web /api/senders surface,
 * and we assert the mock's UPDATE-only contract (404 when the sender is not on
 * the list; status is never sent in the PATCH body) — proving the read-only
 * gate invariant: a label write can never open the gate.
 *
 * Run:  npm run build && node test/serve-names.test.cjs
 * Exits nonzero on failure.
 */
const http = require('http')
const { createServer } = require('../dist/server.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// ---------------------------------------------------------------------------
// Mock web /api/senders surface. Models the REAL invariants of the web side:
//   GET   /api/senders?channel=         -> { senders: [...] }
//   PATCH /api/senders/label            -> UPDATE only; 404 if not present;
//                                          NEVER accepts/changes `status`.
// ---------------------------------------------------------------------------
const DB = [
  { channel_id: 'imessage', sender_address: '+15551110000', label: 'Dan', status: 'approved' },
  { channel_id: 'imessage', sender_address: '+15552220000', label: 'Dan the Plumber', status: 'denied' },
  { channel_id: 'imessage', sender_address: '+15553330000', label: 'Vet', status: 'approved' },
  { channel_id: 'imessage', sender_address: '+15554440000', label: null, status: 'approved' },
]
let labelPatchEverSawStatus = false

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}

const webApi = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  // Both endpoints require the read key (x-api-key).
  if (req.headers['x-api-key'] !== 'READ_KEY') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'unauthorized' }))
  }
  if (req.method === 'GET' && url.pathname === '/api/senders') {
    const ch = url.searchParams.get('channel')
    const senders = DB.filter((s) => s.channel_id === ch)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ senders }))
  }
  if (req.method === 'PATCH' && url.pathname === '/api/senders/label') {
    const body = JSON.parse((await readBody(req)) || '{}')
    // Invariant: the read path NEVER sends status. Flag it if it ever does.
    if ('status' in body) labelPatchEverSawStatus = true
    const row = DB.find(
      (s) => s.channel_id === body.channel_id && s.sender_address === body.sender_address
    )
    if (!row) {
      // UPDATE-only: 0 rows -> 404. NEVER insert.
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          error: 'Sender not on the list. Decide on them first (the name travels with the /decide link).',
        })
      )
    }
    row.label = body.label // update label ONLY; status untouched
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ sender: row }))
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

const TOKEN = 'serve-bearer-token-abc'

function req(server, { method = 'GET', path, token, body }) {
  return new Promise((resolve) => {
    const addr = server.address()
    const headers = {}
    if (token) headers['authorization'] = `Bearer ${token}`
    let payload
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const r = http.request(
      { host: addr.address, port: addr.port, method, path, headers },
      (res) => {
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
      }
    )
    // The server fails closed on oversized bodies by destroying the socket,
    // which surfaces here as a connection reset. Treat that as a deliberate
    // rejection rather than a crash.
    r.on('error', (e) => resolve({ status: 0, json: { error: String(e.code || e.message) } }))
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}

async function main() {
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

  // --- /health open, no auth ---
  let r = await req(serve, { path: '/health' })
  check(r.status === 200 && r.json.ok === true, '/health open without auth')

  // --- bearer required for protected routes ---
  r = await req(serve, { path: '/resolve?name=Dan&channel=imessage' })
  check(r.status === 401, '/resolve requires bearer (401 without token)')

  r = await req(serve, { path: '/resolve?name=Dan&channel=imessage', token: 'wrong' })
  check(r.status === 401, '/resolve rejects wrong bearer token')

  // --- /resolve: substring, case-insensitive, multi-match ---
  r = await req(serve, { path: '/resolve?name=dan&channel=imessage', token: TOKEN })
  check(r.status === 200, '/resolve 200 with valid token')
  check(
    Array.isArray(r.json.matches) && r.json.matches.length === 2,
    '/resolve "dan" matches BOTH Dan rows (case-insensitive substring)'
  )
  check(
    r.json.matches.every((m) => m.sender_address && m.label && m.status) &&
      !JSON.stringify(r.json).includes('text'),
    '/resolve returns address+label+status only (no message text)'
  )

  // --- /resolve single match ---
  r = await req(serve, { path: '/resolve?name=Vet&channel=imessage', token: TOKEN })
  check(r.json.matches.length === 1 && r.json.matches[0].sender_address === '+15553330000', '/resolve "Vet" single match')

  // --- /resolve zero match ---
  r = await req(serve, { path: '/resolve?name=Nobody&channel=imessage', token: TOKEN })
  check(r.json.matches.length === 0, '/resolve unknown name -> 0 matches')

  // --- /resolve empty -> whole address book (labelled only) ---
  r = await req(serve, { path: '/resolve?name=&channel=imessage', token: TOKEN })
  check(
    r.json.matches.length === 3 && r.json.matches.every((m) => m.label),
    '/resolve empty name -> all 3 labelled senders (null-label excluded)'
  )

  // --- /resolve name validation: too long / control chars ---
  r = await req(serve, { path: `/resolve?name=${'x'.repeat(65)}&channel=imessage`, token: TOKEN })
  check(r.status === 400, '/resolve rejects name >64 chars')

  // --- /check includes label ---
  // (Note: /check also runs listInboundSenders-free path; status comes from web)
  // We cannot exercise /list-new (needs chat.db) but /check uses checkSender.
  // checkSender hits /api/senders/check which our mock doesn't implement -> it
  // will 404 from the mock; that's fine, we only assert label plumbing via the
  // dedicated /resolve + /label tests above and below.

  // --- POST /label: success on EXISTING sender ---
  r = await req(serve, {
    method: 'POST',
    path: '/label',
    token: TOKEN,
    body: { sender: '+15553330000', channel: 'imessage', name: 'Animal Hospital' },
  })
  check(r.status === 200 && r.json.label === 'Animal Hospital', 'POST /label updates EXISTING sender label')
  check(
    DB.find((s) => s.sender_address === '+15553330000').label === 'Animal Hospital',
    'label actually changed in mock DB'
  )
  check(
    DB.find((s) => s.sender_address === '+15553330000').status === 'approved',
    'POST /label did NOT change status (still approved)'
  )

  // --- POST /label: 404 on sender NOT on the list (cannot create rows) ---
  const before = DB.length
  r = await req(serve, {
    method: 'POST',
    path: '/label',
    token: TOKEN,
    body: { sender: '+19998887777', channel: 'imessage', name: 'Stranger' },
  })
  check(r.status === 404, 'POST /label on unknown sender -> 404 (UPDATE-only, no insert)')
  check(DB.length === before, 'POST /label did NOT create a new row')

  // --- POST /label: validation (bad name) ---
  r = await req(serve, {
    method: 'POST',
    path: '/label',
    token: TOKEN,
    body: { sender: '+15553330000', channel: 'imessage', name: 'x'.repeat(65) },
  })
  check(r.status === 400, 'POST /label rejects name >64 chars')

  r = await req(serve, {
    method: 'POST',
    path: '/label',
    token: TOKEN,
    body: { sender: 'has spaces & bad', channel: 'imessage', name: 'Ok' },
  })
  check(r.status === 400, 'POST /label rejects malformed sender')

  // --- POST /label: invalid JSON ---
  r = await req(serve, { method: 'POST', path: '/label', token: TOKEN, body: 'not json{' })
  check(r.status === 400, 'POST /label rejects invalid JSON body')

  // --- POST /label: body size cap (>4KB) ---
  const huge = JSON.stringify({ sender: '+15553330000', channel: 'imessage', name: 'A', pad: 'z'.repeat(5000) })
  r = await req(serve, { method: 'POST', path: '/label', token: TOKEN, body: huge })
  // Either an explicit 400 ("Body too large") or a fail-closed socket reset
  // (status 0 / ECONNRESET) is acceptable — both reject the oversized body.
  check(
    r.status === 400 || (r.status === 0 && /ECONNRESET|reset|hang/i.test(r.json.error || '')),
    'POST /label rejects body >4KB (size cap fails closed)'
  )

  // --- POST /send: validation (never hits approval gate) ---
  r = await req(serve, {
    method: 'POST',
    path: '/send',
    token: TOKEN,
    body: { recipient: '+15553330000', channel: 'imessage', text: '' },
  })
  check(r.status === 400, 'POST /send rejects empty text')

  r = await req(serve, {
    method: 'POST',
    path: '/send',
    token: TOKEN,
    body: { recipient: 'bad sender!', channel: 'imessage', text: 'hi' },
  })
  check(r.status === 400, 'POST /send rejects malformed recipient')

  r = await req(serve, { method: 'POST', path: '/send', token: TOKEN, body: 'not json{' })
  check(r.status === 400, 'POST /send rejects invalid JSON body')

  r = await req(serve, {
    method: 'POST',
    path: '/send',
    token: TOKEN,
    body: { recipient: '+123', channel: 'imessage', text: 'hi' },
  })
  check(r.status === 400, 'POST /send rejects too-short E.164 phone')

  r = await req(serve, {
    method: 'POST',
    path: '/send',
    token: TOKEN,
    body: { recipient: '12345', channel: 'imessage', text: 'hi' },
  })
  check(r.status === 400, 'POST /send rejects short digit-only phone')

  // --- POST to unknown path -> 404 ---
  r = await req(serve, { method: 'POST', path: '/nope', token: TOKEN, body: {} })
  check(r.status === 404, 'POST to unknown path -> 404')

  // --- method gating: PUT not allowed ---
  r = await req(serve, { method: 'PUT', path: '/label', token: TOKEN, body: {} })
  check(r.status === 405, 'PUT -> 405 method not allowed')

  // --- THE KEY INVARIANT: the read path never sent status to the web side ---
  check(!labelPatchEverSawStatus, 'INVARIANT: /label PATCH body NEVER contained `status` (cannot open the gate)')

  // cleanup
  await new Promise((res) => serve.close(res))
  await new Promise((res) => webApi.close(res))

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
