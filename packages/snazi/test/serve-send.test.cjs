#!/usr/bin/env node
/**
 * Serve-layer tests for POST /send, covering the HTML-email upgrade:
 *   - plain-text send still works (backward compat, text/plain)
 *   - html send produces a multipart/alternative Gmail raw message
 *   - explicit subject flows through to the Subject header
 *   - Outlook html send uses contentType HTML
 *   - a body larger than the old 8 KiB cap is accepted on /send (raised cap)
 *   - a missing body (no text, no html) -> 400
 *
 * No prod network: globalThis.fetch is stubbed to model the Gmail + Graph send
 * APIs and their OAuth token endpoints.
 *
 * Run:  npm run build && node test/serve-send.test.cjs
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

const sends = []
function installFetch() {
  sends.length = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token') || u.includes('login.microsoftonline.com')) {
      return resp({ access_token: 'AT', expires_in: 3600 })
    }
    if (u.endsWith('/messages/send')) {
      sends.push({ provider: 'gmail', body: JSON.parse(init.body) })
      return resp({ id: 'sent-1' })
    }
    if (u.endsWith('/me/sendMail')) {
      sends.push({ provider: 'outlook', body: JSON.parse(init.body) })
      return resp({}, true, 202)
    }
    return resp({ error: `unexpected ${u}` }, false, 500)
  }
}

const TOKEN = 'serve-bearer-token-xyz'

function req(server, { method = 'POST', path, token, body }) {
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

const gmailRaw = () =>
  Buffer.from(sends.find((s) => s.provider === 'gmail').body.raw, 'base64url').toString('utf8')

async function main() {
  installFetch()
  clearTokenCache()

  const cfg = {
    serveToken: TOKEN,
    channels: [
      { id: 'gmail-chip', type: 'gmail', name: 'Chip', auth: { clientId: 'c', clientSecret: 's', refreshToken: 'r', user: 'chip@gmail.com' } },
      { id: 'outlook-work', type: 'outlook', name: 'Work', auth: { clientId: 'c', clientSecret: 's', refreshToken: 'r', user: 'chip@work.com' } },
      'imessage',
    ],
  }
  const serve = createServer(cfg)
  await new Promise((res) => serve.listen(0, '127.0.0.1', res))

  // --- backward compat: plain text send ---
  installFetch()
  let r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: { channel: 'gmail-chip', recipient: 'carol@example.com', text: 'Subject: Hey\n\nplain body' },
  })
  check(r.status === 200 && r.json.ok === true, 'plain send -> 200 ok')
  let raw = gmailRaw()
  check(/Content-Type: text\/plain/.test(raw) && !/multipart/.test(raw), 'plain send stays text/plain (no multipart)')
  check(/Subject: Hey/.test(raw), 'plain send parses Subject: line')

  // --- from-override (send-as alias) threads through /send ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'gmail-chip',
      recipient: 'carol@example.com',
      text: 'Subject: Hey\n\nplain body',
      from: 'thetman66@gmail.com',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'from-override send -> 200 ok')
  raw = gmailRaw()
  check(/From: thetman66@gmail.com/.test(raw), 'from-override sets From header via /send')

  // --- html send -> multipart/alternative ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'gmail-chip',
      recipient: 'carol@example.com',
      subject: 'Morning Report',
      html: '<h1>Hi</h1><p>Body</p>',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'html send -> 200 ok')
  raw = gmailRaw()
  check(/multipart\/alternative/.test(raw), 'html send is multipart/alternative')
  check(/text\/plain/.test(raw) && /text\/html/.test(raw), 'html send carries both parts')
  check(/Subject: Morning Report/.test(raw), 'html send uses explicit subject')

  // --- outlook html send ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: { channel: 'outlook-work', recipient: 'carol@example.com', subject: 'S', html: '<p>x</p>' },
  })
  check(r.status === 200 && r.json.ok === true, 'outlook html send -> 200 ok')
  const ol = sends.find((s) => s.provider === 'outlook')
  check(ol.body.message.body.contentType === 'HTML', 'outlook html send uses contentType HTML')
  check(ol.body.message.body.content === '<p>x</p>', 'outlook html body carries the raw html')

  // --- large body (> old 8 KiB cap) is accepted on /send ---
  installFetch()
  const bigHtml = '<div>' + 'x'.repeat(20_000) + '</div>'
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: { channel: 'gmail-chip', recipient: 'carol@example.com', subject: 'Big', html: bigHtml },
  })
  check(r.status === 200 && r.json.ok === true, 'large (>8KiB) html body accepted on /send')

  // --- missing body (no text, no html) -> 400 ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: { channel: 'gmail-chip', recipient: 'carol@example.com' },
  })
  check(r.status === 400, 'send with no text and no html -> 400')

  // --- unauth still blocked ---
  r = await req(serve, { path: '/send', body: { channel: 'gmail-chip', recipient: 'x@y.com', text: 'hi' } })
  check(r.status === 401, '/send requires bearer (401 without token)')

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
