#!/usr/bin/env node
/**
 * Gmail channel adapter tests. No network: globalThis.fetch is stubbed to model
 * the Gmail API + OAuth2 token endpoint. Asserts:
 *   - availability reflects whether OAuth2 creds are configured
 *   - listInboundSenders aggregates inbox From-addresses (count + latest)
 *   - readMessagesFrom decodes bodies + tags direction (both sides)
 *   - sendMessage posts a base64url RFC822 message to /messages/send
 *   - the refresh token is exchanged for an access token (and reused/cached)
 *
 * Run:  npm run build && node test/gmail.test.cjs
 */
const { gmailAdapter } = require('../dist/channels/gmail.js')
const { clearTokenCache } = require('../dist/channels/oauth.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')

function resp(json, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }
}

function metaMsg(id, from, internalDate) {
  return {
    id,
    internalDate,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Date', value: new Date(Number(internalDate)).toUTCString() },
      ],
    },
  }
}

function fullMsg(id, from, subject, body, internalDate) {
  return {
    id,
    internalDate,
    snippet: body.slice(0, 20),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      body: { data: b64url(body) },
    },
  }
}

const ctx = {
  id: 'gmail-work',
  type: 'gmail',
  name: 'Work',
  auth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rtok' },
}

const calls = []
let tokenExchanges = 0

function installFetch() {
  calls.length = 0
  tokenExchanges = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const q = decodeURIComponent(u)
    calls.push({ url: u, init })

    if (u.includes('oauth2.googleapis.com/token')) {
      tokenExchanges++
      return resp({ access_token: 'AT123', expires_in: 3600 })
    }
    // Send (POST) before the generic /messages/<id> matcher.
    if (u.endsWith('/messages/send')) {
      return resp({ id: 'sent-1' })
    }
    // List messages: '/messages?q=...'
    if (/\/messages\?/.test(u)) {
      if (q.includes('in:inbox')) return resp({ messages: [{ id: 'm1' }, { id: 'm2' }] })
      if (q.includes('from:alice@example.com')) return resp({ messages: [{ id: 'r1' }] })
      return resp({ messages: [] })
    }
    // Get one message: '/messages/<id>?...'
    const m = u.match(/\/messages\/([^?]+)/)
    if (m) {
      const id = m[1]
      if (u.includes('format=metadata')) {
        if (id === 'm1') return resp(metaMsg('m1', 'Alice <alice@example.com>', '1000'))
        if (id === 'm2') return resp(metaMsg('m2', 'bob@example.com', '2000'))
      }
      if (u.includes('format=full')) {
        if (id === 'r1')
          return resp(fullMsg('r1', 'alice@example.com', 'Hi there', 'hello world', '1500'))
      }
    }
    return resp({ error: `unexpected url ${u}` }, false, 500)
  }
}

async function main() {
  // --- availability ---
  check(gmailAdapter.availability(ctx).available === true, 'available when OAuth creds present')
  const bare = { ...ctx, auth: {} }
  const avBare = gmailAdapter.availability(bare)
  check(avBare.available === false, 'unavailable when creds missing')
  check(/clientId/.test(avBare.reason || ''), 'missing-creds reason names the fields')
  check(gmailAdapter.platforms.length === 0, 'gmail runs on any platform')

  installFetch()
  clearTokenCache()

  // --- listInboundSenders ---
  const senders = await gmailAdapter.listInboundSenders(ctx, 60)
  check(senders.length === 2, `lists 2 distinct senders (got ${senders.length})`)
  const addrs = senders.map((s) => s.sender)
  check(
    addrs.includes('alice@example.com') && addrs.includes('bob@example.com'),
    'extracts bare email from "Name <email>" and plain forms'
  )
  check(
    senders.every((s) => s.message_count === 1),
    'per-sender message_count populated'
  )
  // bob has the later internalDate (2000) so should sort first.
  check(senders[0].sender === 'bob@example.com', 'senders sorted by latest first')
  check(tokenExchanges === 1, 'refresh token exchanged exactly once (cached)')

  // --- readMessagesFrom ---
  const rows = await gmailAdapter.readMessagesFrom(ctx, 'alice@example.com', 120)
  check(rows.length === 1, `reads 1 message from alice (got ${rows.length})`)
  check(/Hi there/.test(rows[0].text) && /hello world/.test(rows[0].text), 'subject + decoded body in text')
  check(rows[0].direction === 'incoming' && rows[0].from_me === false, 'incoming message tagged correctly')
  check(rows[0].date === new Date(1500).toISOString(), 'date derived from internalDate')
  check(tokenExchanges === 1, 'access token reused from cache (no second exchange)')

  // --- sendMessage ---
  await gmailAdapter.sendMessage(ctx, 'carol@example.com', 'Subject: Yo\n\nbody text')
  const sendCall = calls.find((c) => c.url.endsWith('/messages/send'))
  check(Boolean(sendCall) && sendCall.init.method === 'POST', 'sendMessage POSTs to /messages/send')
  const sentRaw = JSON.parse(sendCall.init.body).raw
  const decoded = Buffer.from(sentRaw, 'base64url').toString('utf8')
  check(/To: carol@example.com/.test(decoded), 'send raw has To header')
  check(/Subject: Yo/.test(decoded) && /body text/.test(decoded), 'send raw carries parsed subject + body')
  check(/Content-Type: text\/plain/.test(decoded), 'plain send stays text/plain')
  check(!/multipart\/alternative/.test(decoded), 'plain send is NOT multipart')

  // --- sendMessage: HTML (multipart/alternative) ---
  calls.length = 0
  await gmailAdapter.sendMessage(ctx, 'carol@example.com', '', {
    subject: 'Morning Report',
    html: '<h1>Hello</h1><p>Line one</p>',
  })
  const htmlSend = calls.find((c) => c.url.endsWith('/messages/send'))
  const htmlRaw = Buffer.from(JSON.parse(htmlSend.init.body).raw, 'base64url').toString('utf8')
  check(/Content-Type: multipart\/alternative/.test(htmlRaw), 'html send is multipart/alternative')
  check(/Subject: Morning Report/.test(htmlRaw), 'html send carries explicit subject')
  check(
    /Content-Type: text\/plain/.test(htmlRaw) && /Content-Type: text\/html/.test(htmlRaw),
    'html send has BOTH text/plain and text/html parts'
  )
  // Both part bodies are base64 encoded; decode the html part and check it.
  const htmlPartB64 = htmlRaw
    .split(/--=_snazi_[^\r\n]+/)
    .find((seg) => /text\/html/.test(seg))
    .split(/\r?\n\r?\n/)[1]
    .replace(/\r?\n/g, '')
  check(
    Buffer.from(htmlPartB64, 'base64').toString('utf8') === '<h1>Hello</h1><p>Line one</p>',
    'html part decodes back to the original HTML'
  )
  // Plaintext alternative was derived from the HTML (no explicit --text).
  const textPartB64 = htmlRaw
    .split(/--=_snazi_[^\r\n]+/)
    .find((seg) => /text\/plain/.test(seg))
    .split(/\r?\n\r?\n/)[1]
    .replace(/\r?\n/g, '')
  const textPart = Buffer.from(textPartB64, 'base64').toString('utf8')
  check(/Hello/.test(textPart) && /Line one/.test(textPart), 'plaintext alt derived from HTML via htmlToText')
  check(!/<h1>/.test(textPart), 'plaintext alt has tags stripped')

  // --- sendMessage: HTML with explicit plaintext alternative ---
  calls.length = 0
  await gmailAdapter.sendMessage(ctx, 'carol@example.com', 'PLAIN ALT TEXT', {
    subject: 'S',
    html: '<p>rich</p>',
  })
  const raw2 = Buffer.from(
    JSON.parse(calls.find((c) => c.url.endsWith('/messages/send')).init.body).raw,
    'base64url'
  ).toString('utf8')
  const textPart2 = Buffer.from(
    raw2
      .split(/--=_snazi_[^\r\n]+/)
      .find((seg) => /text\/plain/.test(seg))
      .split(/\r?\n\r?\n/)[1]
      .replace(/\r?\n/g, ''),
    'base64'
  ).toString('utf8')
  check(textPart2 === 'PLAIN ALT TEXT', 'explicit --text becomes the plaintext alternative')

  // --- error surfacing ---
  globalThis.fetch = async () => resp({ error: 'boom' }, false, 502)
  clearTokenCache()
  let threw = false
  try {
    await gmailAdapter.listInboundSenders(ctx, 60)
  } catch {
    threw = true
  }
  check(threw, 'token-exchange failure throws (does not silently succeed)')

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
