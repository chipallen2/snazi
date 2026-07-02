#!/usr/bin/env node
/**
 * Serve-layer tests for the filter/rule CRUD endpoints:
 *   POST   /filter/create
 *   GET    /filter/list
 *   GET    /filter/get
 *   PATCH  /filter/update   (Outlook only; Gmail -> 405)
 *   DELETE /filter/delete
 *
 * No prod network: globalThis.fetch is stubbed to model the Gmail + Graph
 * filter APIs and their OAuth token endpoints. Asserts bearer auth, method
 * gating, validation, provider routing, and the Gmail-no-update 405 contract.
 *
 * Run:  npm run build && node test/serve-filters.test.cjs
 */
const http = require('http')
const { createServer } = require('../dist/server.js')
const { clearTokenCache } = require('../dist/channels/oauth.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

function resp(json, ok = true, status = 200) {
  return { ok, status, json: async () => json, text: async () => JSON.stringify(json) }
}

// Stub both providers' APIs. Gmail is on gmail.googleapis.com; Graph on
// graph.microsoft.com; tokens on their respective OAuth endpoints.
function installFetch() {
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    if (u.includes('oauth2.googleapis.com/token') || u.includes('login.microsoftonline.com')) {
      return resp({ access_token: 'AT', expires_in: 3600 })
    }
    // Gmail filters
    if (u.includes('/settings/filters')) {
      if (u.endsWith('/settings/filters') && method === 'POST') {
        return resp({ id: 'f-new', ...JSON.parse(init.body) })
      }
      if (u.endsWith('/settings/filters')) {
        return resp({ filter: [{ id: 'f1', criteria: { from: 'a@x.com' }, action: { addLabelIds: ['TRASH'] } }] })
      }
      if (/\/settings\/filters\/[^/]+/.test(u) && method === 'DELETE') return resp({}, true, 204)
      if (/\/settings\/filters\/[^/]+/.test(u)) {
        return resp({ id: 'f1', criteria: { from: 'a@x.com' }, action: { addLabelIds: ['TRASH'] } })
      }
    }
    // Graph messageRules
    if (u.includes('/messageRules')) {
      if (/\/messageRules$/.test(u) && method === 'POST') return resp({ id: 'r-new', ...JSON.parse(init.body) })
      if (/\/messageRules$/.test(u) && method === 'GET') return resp({ value: [{ id: 'r0', sequence: 1 }] })
      if (/\/messageRules\/[^/]+/.test(u) && method === 'PATCH') return resp({ id: 'r1', ...JSON.parse(init.body) })
      if (/\/messageRules\/[^/]+/.test(u) && method === 'DELETE') return resp({}, true, 204)
      if (/\/messageRules\/[^/]+/.test(u)) return resp({ id: 'r1', actions: { markAsRead: true } })
    }
    return resp({ error: `unexpected ${u}` }, false, 500)
  }
}

const TOKEN = 'serve-bearer-token-xyz'

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
          try { json = JSON.parse(s) } catch { json = { _raw: s } }
          resolve({ status: res.statusCode, json })
        })
      }
    )
    r.on('error', (e) => resolve({ status: 0, json: { error: String(e.code || e.message) } }))
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}

async function main() {
  installFetch()
  clearTokenCache()

  const cfg = {
    serveToken: TOKEN,
    channels: [
      { id: 'gmail-chip', type: 'gmail', name: 'Chip', auth: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } },
      { id: 'outlook-work', type: 'outlook', name: 'Work', auth: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } },
      'imessage',
    ],
  }
  const serve = createServer(cfg)
  await new Promise((res) => serve.listen(0, '127.0.0.1', res))

  // --- auth ---
  let r = await req(serve, { path: '/filter/list?channel=gmail-chip' })
  check(r.status === 401, '/filter/list requires bearer (401 without token)')

  // --- method gating: PUT not allowed ---
  r = await req(serve, { method: 'PUT', path: '/filter/list?channel=gmail-chip', token: TOKEN })
  check(r.status === 405, 'PUT rejected with 405 (method not allowed)')

  // --- Gmail create (delete) ---
  r = await req(serve, {
    method: 'POST',
    path: '/filter/create',
    token: TOKEN,
    body: { channel: 'gmail-chip', from: 'noreply@x.com', action: 'delete' },
  })
  check(r.status === 200 && r.json.ok === true && r.json.filter.id === 'f-new', 'gmail POST /filter/create 200 with new id')

  // --- invalid action -> 400 ---
  r = await req(serve, {
    method: 'POST',
    path: '/filter/create',
    token: TOKEN,
    body: { channel: 'gmail-chip', from: 'a@x.com', action: 'bogus' },
  })
  check(r.status === 400, 'invalid action -> 400')

  // --- Gmail list ---
  r = await req(serve, { path: '/filter/list?channel=gmail-chip', token: TOKEN })
  check(r.status === 200 && Array.isArray(r.json.filters) && r.json.count === 1, 'gmail /filter/list 200 with filters[]')

  // --- Gmail get ---
  r = await req(serve, { path: '/filter/get?channel=gmail-chip&id=f1', token: TOKEN })
  check(r.status === 200 && r.json.filter.id === 'f1', 'gmail /filter/get 200')

  // --- get without id -> 400 ---
  r = await req(serve, { path: '/filter/get?channel=gmail-chip', token: TOKEN })
  check(r.status === 400, 'gmail /filter/get without id -> 400')

  // --- Gmail update -> 405 (no update API) ---
  r = await req(serve, {
    method: 'PATCH',
    path: '/filter/update?channel=gmail-chip&id=f1',
    token: TOKEN,
    body: { action: 'markRead' },
  })
  check(r.status === 405, 'gmail PATCH /filter/update -> 405 (delete+recreate)')

  // --- Gmail delete ---
  r = await req(serve, { method: 'DELETE', path: '/filter/delete?channel=gmail-chip&id=f1', token: TOKEN })
  check(r.status === 200 && r.json.deleted === true, 'gmail DELETE /filter/delete 200')

  // --- Outlook create ---
  r = await req(serve, {
    method: 'POST',
    path: '/filter/create',
    token: TOKEN,
    body: { channel: 'outlook-work', from: 'noreply@x.com', action: 'delete' },
  })
  check(r.status === 200 && r.json.filter.id === 'r-new', 'outlook POST /filter/create 200')

  // --- Outlook update (supported) ---
  r = await req(serve, {
    method: 'PATCH',
    path: '/filter/update?channel=outlook-work&id=r1',
    token: TOKEN,
    body: { action: 'markRead' },
  })
  check(r.status === 200 && r.json.ok === true, 'outlook PATCH /filter/update 200')

  // --- imessage has no filters -> 501 ---
  r = await req(serve, { path: '/filter/list?channel=imessage', token: TOKEN })
  check(r.status === 501, 'imessage /filter/list -> 501 (no filter support)')

  // --- unknown POST path still 404 ---
  r = await req(serve, { method: 'POST', path: '/filter/bogus', token: TOKEN, body: {} })
  check(r.status === 404, 'unknown POST path -> 404')

  serve.close()
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
