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
    // Gmail: fetch original message metadata for a threaded reply.
    if (/\/messages\/[^/?]+\?/.test(u) && u.includes('format=metadata')) {
      return resp({
        id: 'orig-1',
        threadId: 'T-1',
        payload: {
          headers: [
            { name: 'Message-ID', value: '<o@x>' },
            { name: 'References', value: '' },
            { name: 'Subject', value: 'Hi' },
            { name: 'To', value: 'chip@gmail.com' },
            { name: 'Cc', value: '' },
          ],
        },
      })
    }
    // Gmail: fetch the original full message for a forward (no attachments
    // in this fixture; keeps the serve-level test focused on passthrough).
    if (/\/messages\/fwd-orig-1\?/.test(u) && u.includes('format=full')) {
      return resp({
        id: 'fwd-orig-1',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Rebecca <rebeccac@newmanwindows.com>' },
            { name: 'Date', value: 'Wed, 08 Jul 2026 10:00:00 -0700' },
            { name: 'Subject', value: 'Window quote' },
            { name: 'To', value: 'chip@gmail.com' },
          ],
          body: { data: Buffer.from('Original body text.', 'utf8').toString('base64url') },
        },
      })
    }
    // Outlook native forward endpoint (match before /me/sendMail).
    if (/\/me\/messages\/[^/]+\/forward$/.test(u)) {
      sends.push({ provider: 'outlook-forward', body: JSON.parse(init.body) })
      return resp({}, true, 202)
    }
    if (u.endsWith('/messages/send')) {
      sends.push({ provider: 'gmail', body: JSON.parse(init.body) })
      return resp({ id: 'sent-1' })
    }
    // Outlook native reply endpoints (match before /me/sendMail is irrelevant).
    if (/\/me\/messages\/[^/]+\/replyAll$/.test(u)) {
      sends.push({ provider: 'outlook-replyAll', body: JSON.parse(init.body) })
      return resp({}, true, 202)
    }
    if (/\/me\/messages\/[^/]+\/reply$/.test(u)) {
      sends.push({ provider: 'outlook-reply', body: JSON.parse(init.body) })
      return resp({}, true, 202)
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

  // --- gmail reply threads through /send (replyToMessageId) ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'gmail-chip',
      recipient: 'alice@example.com',
      text: 'thanks, got it',
      replyToMessageId: 'orig-1',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'gmail reply send -> 200 ok')
  const gReply = sends.find((s) => s.provider === 'gmail')
  check(gReply.body.threadId === 'T-1', 'serve /send sets original threadId on gmail reply')
  raw = Buffer.from(gReply.body.raw, 'base64url').toString('utf8')
  check(/In-Reply-To: <o@x>/.test(raw), 'serve /send builds In-Reply-To for gmail reply')
  check(/Subject: Re: Hi/.test(raw), 'serve /send derives Re: subject for gmail reply')

  // --- outlook reply routes to the native /reply endpoint ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'outlook-work',
      recipient: 'alice@example.com',
      text: 'ok sounds good',
      replyToMessageId: 'in-9',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'outlook reply send -> 200 ok')
  const oReply = sends.find((s) => s.provider === 'outlook-reply')
  check(Boolean(oReply), 'serve /send routes outlook reply to native /reply endpoint')
  check(oReply.body.comment === 'ok sounds good', 'serve /send carries outlook reply comment')
  check(
    !sends.some((s) => s.provider === 'outlook'),
    'outlook reply does NOT hit send-new (/me/sendMail)'
  )

  // --- gmail forward threads through /send (forwardMessageId) ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'gmail-chip',
      recipient: 'hannah@example.com',
      text: 'FYI, looping you in',
      forwardMessageId: 'fwd-orig-1',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'gmail forward send -> 200 ok')
  const gFwd = sends.find((s) => s.provider === 'gmail')
  check(gFwd.body.threadId === undefined, 'serve /send does NOT set threadId on a gmail forward')
  const fwdRaw = Buffer.from(gFwd.body.raw, 'base64url').toString('utf8')
  check(/Subject: Fwd: Window quote/.test(fwdRaw), 'serve /send derives Fwd: subject for gmail forward')
  check(/To: hannah@example\.com/.test(fwdRaw), 'serve /send forward To is the caller recipient')
  check(
    /---------- Forwarded message ---------/.test(fwdRaw),
    'serve /send forward includes the forwarded-header block'
  )

  // --- gmail forward with NO --text still sends (comment optional) ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'gmail-chip',
      recipient: 'hannah@example.com',
      forwardMessageId: 'fwd-orig-1',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'gmail forward with no --text -> 200 ok (comment optional)')

  // --- outlook forward routes to the native /forward endpoint ---
  installFetch()
  r = await req(serve, {
    path: '/send',
    token: TOKEN,
    body: {
      channel: 'outlook-work',
      recipient: 'hannah@example.com',
      text: 'FYI looping you in',
      forwardMessageId: 'in-9',
    },
  })
  check(r.status === 200 && r.json.ok === true, 'outlook forward send -> 200 ok')
  const oFwd = sends.find((s) => s.provider === 'outlook-forward')
  check(Boolean(oFwd), 'serve /send routes outlook forward to native /forward endpoint')
  check(oFwd.body.comment === 'FYI looping you in', 'serve /send carries outlook forward comment')
  check(
    oFwd.body.toRecipients?.[0]?.emailAddress?.address === 'hannah@example.com',
    'serve /send outlook forward sets toRecipients to the caller recipient'
  )
  check(
    !sends.some((s) => s.provider === 'outlook'),
    'outlook forward does NOT hit send-new (/me/sendMail)'
  )

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
