#!/usr/bin/env node
/**
 * Serve-layer tests for the calendar endpoints:
 *   GET  /calendar/list
 *   POST /calendar/create
 *
 * No prod network: globalThis.fetch is stubbed to model Graph + its OAuth token
 * endpoint. Asserts bearer auth, name->id resolution, all-day day-after math
 * over the wire, validation, ungated behavior, and the imessage-no-calendar
 * 501 contract.
 *
 * Run:  npm run build && node test/serve-calendar.test.cjs
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

let lastEventBody = null
function installFetch() {
  lastEventBody = null
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    if (u.includes('login.microsoftonline.com')) {
      return resp({ access_token: '***', expires_in: 3600 })
    }
    if (u.includes('/me/calendars') && method === 'GET' && !/\/events$/.test(u)) {
      return resp({
        value: [
          { id: 'cal-default', name: 'Calendar', isDefaultCalendar: true },
          { id: 'cal-vac', name: 'Vacation' },
        ],
      })
    }
    if (/\/me\/calendars\/[^/]+\/events$/.test(u) && method === 'POST') {
      lastEventBody = JSON.parse(init.body)
      return resp({ id: 'evt-1', ...lastEventBody })
    }
    return resp({ error: `unexpected ${u}` }, false, 500)
  }
}

const TOKEN = 'serve-cal-xyz'

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
      { id: 'outlook-work', type: 'outlook', name: 'Work', auth: { clientId: 'c', clientSecret: '***', refreshToken: 'r' } },
      'imessage',
    ],
  }
  const serve = createServer(cfg)
  await new Promise((res) => serve.listen(0, '127.0.0.1', res))

  // --- auth ---
  let r = await req(serve, { path: '/calendar/list?channel=outlook-work' })
  check(r.status === 401, '/calendar/list requires bearer (401 without token)')

  // --- list ---
  r = await req(serve, { path: '/calendar/list?channel=outlook-work', token: TOKEN })
  check(r.status === 200 && r.json.count === 2, 'GET /calendar/list 200 with 2 calendars')
  check(r.json.calendars.some((c) => c.name === 'Vacation'), 'list includes the Vacation calendar')

  // --- create all-day by NAME (resolves to id), single day ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'Vacation', subject: 'Abhi Vacation', start: '2026-07-20', allDay: true },
  })
  check(r.status === 200 && r.json.ok === true, 'POST /calendar/create 200 (name resolved)')
  check(lastEventBody && lastEventBody.start.dateTime === '2026-07-20T00:00:00', 'wire: all-day start midnight')
  check(lastEventBody && lastEventBody.end.dateTime === '2026-07-21T00:00:00', 'wire: all-day end is day-after')

  // --- create all-day range by NAME ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'Vacation', subject: 'Busy', start: '2026-08-20', end: '2026-08-25', allDay: true },
  })
  check(r.status === 200 && lastEventBody.end.dateTime === '2026-08-26T00:00:00', 'wire: inclusive range end Aug25 -> Aug26 exclusive')

  // --- create by exact id passes through ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'cal-vac', subject: 'ById', start: '2026-07-21', allDay: true },
  })
  check(r.status === 200 && r.json.ok === true, 'create by calendar id succeeds')

  // --- unknown calendar name -> 404 ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'Nope', subject: 'x', start: '2026-07-20', allDay: true },
  })
  check(r.status === 404, 'unknown calendar name -> 404')

  // --- missing subject -> 400 ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'Vacation', start: '2026-07-20', allDay: true },
  })
  check(r.status === 400, 'missing subject -> 400')

  // --- bad date shape -> 400 ---
  r = await req(serve, {
    method: 'POST',
    path: '/calendar/create',
    token: TOKEN,
    body: { channel: 'outlook-work', calendar: 'Vacation', subject: 'x', start: 'garbage', allDay: true },
  })
  check(r.status === 400, 'invalid start date -> 400')

  // --- imessage has no calendar -> 501 ---
  r = await req(serve, { path: '/calendar/list?channel=imessage', token: TOKEN })
  check(r.status === 501, 'imessage /calendar/list -> 501 (no calendar support)')

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
