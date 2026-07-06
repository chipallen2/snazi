#!/usr/bin/env node
/**
 * Outlook (Microsoft Graph) channel adapter tests. No network: globalThis.fetch
 * is stubbed to model Graph + the Microsoft OAuth2 token endpoint. Asserts:
 *   - availability reflects whether OAuth2 creds are configured
 *   - listInboundSenders aggregates inbox From-addresses (count + latest)
 *   - readMessagesFrom merges inbound + sent (to that address) with directions,
 *     and converts HTML bodies to text
 *   - sendMessage POSTs to /me/sendMail with the right recipient
 *   - the refresh token is exchanged for an access token (tenant honored)
 *
 * Run:  npm run build && node test/outlook.test.cjs
 */
const { outlookAdapter } = require('../dist/channels/outlook.js')
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
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }
}

const ctx = {
  id: 'outlook-work',
  type: 'outlook',
  name: 'Work',
  auth: {
    clientId: 'cid',
    clientSecret: 'secret',
    refreshToken: 'rtok',
    tenantId: 'contoso',
  },
}

const calls = []
let tokenUrlSeen = ''

function installFetch() {
  calls.length = 0
  tokenUrlSeen = ''
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const q = decodeURIComponent(u)
    calls.push({ url: u, init })

    if (u.includes('login.microsoftonline.com')) {
      tokenUrlSeen = u
      return resp({ access_token: 'AT123', expires_in: 3600 })
    }
    if (u.endsWith('/me/sendMail')) {
      return resp({}, true, 202) // Graph returns 202 Accepted, no body
    }
    // Native reply / replyAll endpoints (match before the generic /me/messages).
    if (/\/me\/messages\/[^/]+\/replyAll$/.test(u)) {
      return resp({}, true, 202)
    }
    if (/\/me\/messages\/[^/]+\/reply$/.test(u)) {
      return resp({}, true, 202)
    }
    if (u.includes('/mailFolders/inbox/messages')) {
      return resp({
        value: [
          {
            from: { emailAddress: { address: 'alice@example.com' } },
            receivedDateTime: '2024-01-02T00:00:00Z',
          },
          {
            from: { emailAddress: { address: 'bob@example.com' } },
            receivedDateTime: '2024-01-01T00:00:00Z',
          },
        ],
      })
    }
    if (u.includes('/mailFolders/sentitems/messages')) {
      return resp({
        value: [
          {
            id: 'sent-1',
            subject: 'Re: hi',
            toRecipients: [{ emailAddress: { address: 'alice@example.com' } }],
            sentDateTime: '2024-01-03T00:00:00Z',
            body: { contentType: 'html', content: '<p>bye <b>now</b></p>' },
          },
          {
            subject: 'Unrelated',
            toRecipients: [{ emailAddress: { address: 'someone@else.com' } }],
            sentDateTime: '2024-01-03T01:00:00Z',
            body: { contentType: 'text', content: 'nope' },
          },
        ],
      })
    }
    if (u.includes('/me/messages') && q.includes("from/emailAddress/address eq 'alice@example.com'")) {
      return resp({
        value: [
          {
            id: 'in-1',
            subject: 'Hi',
            from: { emailAddress: { address: 'alice@example.com' } },
            receivedDateTime: '2024-01-02T00:00:00Z',
            body: { contentType: 'text', content: 'hello there' },
          },
        ],
      })
    }
    return resp({ error: `unexpected url ${u}` }, false, 500)
  }
}

async function main() {
  // --- availability ---
  check(outlookAdapter.availability(ctx).available === true, 'available when OAuth creds present')
  const avBare = outlookAdapter.availability({ ...ctx, auth: {} })
  check(avBare.available === false, 'unavailable when creds missing')
  check(/refreshToken/.test(avBare.reason || ''), 'missing-creds reason names the fields')
  check(outlookAdapter.platforms.length === 0, 'outlook runs on any platform')

  installFetch()
  clearTokenCache()

  // --- listInboundSenders ---
  const senders = await outlookAdapter.listInboundSenders(ctx, 60)
  check(senders.length === 2, `lists 2 distinct senders (got ${senders.length})`)
  check(senders[0].sender === 'alice@example.com', 'senders sorted by latest first (alice newer)')
  check(
    tokenUrlSeen.includes('/contoso/oauth2'),
    'token endpoint honors the configured tenant id'
  )

  // --- readMessagesFrom (both directions, HTML->text) ---
  const rows = await outlookAdapter.readMessagesFrom(ctx, 'alice@example.com', 1440)
  check(rows.length === 2, `merges inbound + sent-to-alice (got ${rows.length})`)
  const inbound = rows.find((r) => r.direction === 'incoming')
  const outbound = rows.find((r) => r.direction === 'outgoing')
  check(Boolean(inbound) && /hello there/.test(inbound.text), 'incoming text present')
  check(Boolean(outbound) && /bye now/.test(outbound.text), 'outgoing HTML converted to text')
  check(
    !rows.some((r) => /Unrelated|nope/.test(r.text)),
    'sent mail to a different recipient is excluded'
  )
  check(inbound.id === 'in-1', 'read row exposes native Graph message id')
  check(
    rows[0].date <= rows[1].date,
    'rows sorted chronologically'
  )

  // --- sendMessage ---
  await outlookAdapter.sendMessage(ctx, 'carol@example.com', 'just a body')
  const sendCall = calls.find((c) => c.url.endsWith('/me/sendMail'))
  check(Boolean(sendCall) && sendCall.init.method === 'POST', 'sendMessage POSTs to /me/sendMail')
  const payload = JSON.parse(sendCall.init.body)
  check(
    payload.message.toRecipients[0].emailAddress.address === 'carol@example.com',
    'send payload carries the recipient'
  )
  check(payload.message.body.content === 'just a body', 'send payload carries the body')
  check(payload.message.body.contentType === 'Text', 'plain send uses contentType Text')

  // --- sendMessage: HTML body ---
  calls.length = 0
  await outlookAdapter.sendMessage(ctx, 'carol@example.com', 'plain fallback', {
    subject: 'Rich Report',
    html: '<h1>Hi</h1><p>Body</p>',
  })
  const htmlCall = calls.find((c) => c.url.endsWith('/me/sendMail'))
  const htmlPayload = JSON.parse(htmlCall.init.body)
  check(htmlPayload.message.body.contentType === 'HTML', 'html send uses contentType HTML')
  check(
    htmlPayload.message.body.content === '<h1>Hi</h1><p>Body</p>',
    'html send carries the raw HTML as body content'
  )
  check(htmlPayload.message.subject === 'Rich Report', 'html send uses the explicit subject')

  // --- sendMessage: explicit --subject wins over a Subject: line in text ---
  calls.length = 0
  await outlookAdapter.sendMessage(ctx, 'carol@example.com', 'Subject: FromBody\n\nhi', {
    subject: 'FromFlag',
  })
  const subjCall = calls.find((c) => c.url.endsWith('/me/sendMail'))
  const subjPayload = JSON.parse(subjCall.init.body)
  check(subjPayload.message.subject === 'FromFlag', 'explicit subject overrides Subject: line')
  check(
    subjPayload.message.body.content === 'Subject: FromBody\n\nhi',
    'with explicit subject, whole text is the body (no Subject: stripping)'
  )

  // --- sendMessage: native Graph reply endpoint ---
  calls.length = 0
  await outlookAdapter.sendMessage(ctx, 'alice@example.com', 'my reply', {
    replyToMessageId: 'in-1',
  })
  const replyCall = calls.find((c) => /\/me\/messages\/in-1\/reply$/.test(c.url))
  check(
    Boolean(replyCall) && replyCall.init.method === 'POST',
    'reply POSTs to /me/messages/{id}/reply'
  )
  check(
    JSON.parse(replyCall.init.body).comment === 'my reply',
    'reply sends the text as the comment'
  )
  check(
    !calls.some((c) => c.url.endsWith('/me/sendMail')),
    'reply does NOT hit the send-new-message path'
  )

  // --- sendMessage: native Graph reply-all endpoint ---
  calls.length = 0
  await outlookAdapter.sendMessage(ctx, 'alice@example.com', 'all reply', {
    replyToMessageId: 'in-1',
    replyAll: true,
  })
  const replyAllCall = calls.find((c) => /\/me\/messages\/in-1\/replyAll$/.test(c.url))
  check(Boolean(replyAllCall), 'reply-all POSTs to /me/messages/{id}/replyAll')
  check(
    JSON.parse(replyAllCall.init.body).comment === 'all reply',
    'reply-all sends the text as the comment'
  )

  // --- sendMessage: reply uses html as the comment when provided ---
  calls.length = 0
  await outlookAdapter.sendMessage(ctx, 'alice@example.com', 'plain fallback', {
    replyToMessageId: 'in-1',
    html: '<p>rich reply</p>',
  })
  const htmlReply = calls.find((c) => /\/me\/messages\/in-1\/reply$/.test(c.url))
  check(
    JSON.parse(htmlReply.init.body).comment === '<p>rich reply</p>',
    'reply uses html as comment when provided'
  )

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
