#!/usr/bin/env node
/**
 * Filter/rule CRUD tests for the Gmail + Outlook adapters. No network:
 * globalThis.fetch is stubbed to model the Gmail settings.filters API, the
 * Microsoft Graph messageRules API, and each provider's OAuth2 token endpoint.
 *
 * Asserts the simplified-spec -> provider-native translation, the CRUD wiring,
 * and that Gmail deliberately has NO updateFilter (delete + recreate pattern).
 *
 * Run:  npm run build && node test/filters.test.cjs
 */
const { gmailAdapter } = require('../dist/channels/gmail.js')
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

const gmailCtx = {
  id: 'gmail-chip',
  type: 'gmail',
  name: 'Chip',
  auth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rtok' },
}
const outlookCtx = {
  id: 'outlook-work',
  type: 'outlook',
  name: 'Work',
  auth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rtok', tenantId: 'contoso' },
}

// ---------------------------------------------------------------------------
// Gmail filters
// ---------------------------------------------------------------------------
const gCalls = []
function installGmailFetch() {
  gCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    gCalls.push({ url: u, init })
    if (u.includes('oauth2.googleapis.com/token')) {
      return resp({ access_token: 'AT', expires_in: 3600 })
    }
    // Create: POST /settings/filters -> echo body with an id.
    if (u.endsWith('/settings/filters') && init && init.method === 'POST') {
      const body = JSON.parse(init.body)
      return resp({ id: 'f-new', ...body })
    }
    // List: GET /settings/filters
    if (u.endsWith('/settings/filters')) {
      return resp({
        filter: [
          { id: 'f1', criteria: { from: 'noreply@x.com' }, action: { addLabelIds: ['TRASH'] } },
        ],
      })
    }
    // Get one: GET /settings/filters/<id>
    if (/\/settings\/filters\/f1/.test(u) && (!init || init.method === undefined)) {
      return resp({ id: 'f1', criteria: { from: 'noreply@x.com' }, action: { removeLabelIds: ['INBOX'] } })
    }
    // Delete: DELETE /settings/filters/<id>
    if (/\/settings\/filters\/f1/.test(u) && init && init.method === 'DELETE') {
      return resp({}, true, 204)
    }
    return resp({ error: `unexpected ${u}` }, false, 500)
  }
}

async function testGmail() {
  console.log('\nGmail filters:')
  installGmailFetch()
  clearTokenCache()

  check(gmailAdapter.filterAvailability(gmailCtx).available === true, 'gmail filterAvailability true with creds')
  check(typeof gmailAdapter.createFilter === 'function', 'gmail exposes createFilter')
  check(gmailAdapter.updateFilter === undefined, 'gmail has NO updateFilter (delete+recreate)')

  // create delete
  const created = await gmailAdapter.createFilter(gmailCtx, { from: 'noreply@x.com', action: 'delete' })
  const postCall = gCalls.find((c) => c.url.endsWith('/settings/filters') && c.init && c.init.method === 'POST')
  const sentBody = JSON.parse(postCall.init.body)
  check(sentBody.criteria.from === 'noreply@x.com', 'gmail create maps --from to criteria.from')
  check(JSON.stringify(sentBody.action.addLabelIds) === JSON.stringify(['TRASH']), "gmail 'delete' -> addLabelIds TRASH")
  check(created.id === 'f-new', 'gmail create returns new id')
  check(/delete/.test(created.summary), 'gmail create summary mentions delete')

  // archive
  installGmailFetch()
  await gmailAdapter.createFilter(gmailCtx, { from: 'a@x.com', action: 'archive' })
  let b = JSON.parse(gCalls.find((c) => c.init && c.init.method === 'POST').init.body)
  check(JSON.stringify(b.action.removeLabelIds) === JSON.stringify(['INBOX']), "gmail 'archive' -> removeLabelIds INBOX")

  // label requires labelId
  let threw = false
  try {
    await gmailAdapter.createFilter(gmailCtx, { from: 'a@x.com', action: 'label' })
  } catch { threw = true }
  check(threw, "gmail 'label' without labelId throws")

  installGmailFetch()
  await gmailAdapter.createFilter(gmailCtx, { from: 'a@x.com', action: 'label', labelId: 'Label_7' })
  b = JSON.parse(gCalls.find((c) => c.init && c.init.method === 'POST').init.body)
  check(JSON.stringify(b.action.addLabelIds) === JSON.stringify(['Label_7']), "gmail 'label' -> addLabelIds [labelId]")

  // no match -> throws
  threw = false
  try {
    await gmailAdapter.createFilter(gmailCtx, { action: 'delete' })
  } catch { threw = true }
  check(threw, 'gmail create with no match criteria throws')

  // raw passthrough
  installGmailFetch()
  await gmailAdapter.createFilter(gmailCtx, { criteria: { query: 'older_than:1y' }, actions: { addLabelIds: ['TRASH'] } })
  b = JSON.parse(gCalls.find((c) => c.init && c.init.method === 'POST').init.body)
  check(b.criteria.query === 'older_than:1y', 'gmail raw criteria passthrough')

  // list
  installGmailFetch()
  const list = await gmailAdapter.listFilters(gmailCtx)
  check(Array.isArray(list) && list.length === 1 && list[0].id === 'f1', 'gmail listFilters returns records')

  // get
  const one = await gmailAdapter.getFilter(gmailCtx, 'f1')
  check(one.id === 'f1' && /archive/.test(one.summary), 'gmail getFilter returns record w/ summary')

  // delete
  installGmailFetch()
  await gmailAdapter.deleteFilter(gmailCtx, 'f1')
  check(
    Boolean(gCalls.find((c) => /\/settings\/filters\/f1/.test(c.url) && c.init && c.init.method === 'DELETE')),
    'gmail deleteFilter issues DELETE'
  )
}

// ---------------------------------------------------------------------------
// Outlook rules
// ---------------------------------------------------------------------------
const oCalls = []
function installOutlookFetch() {
  oCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = (init && init.method) || 'GET'
    oCalls.push({ url: u, init })
    if (u.includes('login.microsoftonline.com')) {
      return resp({ access_token: 'AT', expires_in: 3600 })
    }
    const isRuleId = /\/messageRules\/r1/.test(u)
    if (isRuleId && method === 'GET') {
      return resp({ id: 'r1', displayName: 'x', conditions: { senderContains: ['a@x.com'] }, actions: { markAsRead: true } })
    }
    if (isRuleId && method === 'PATCH') {
      const body = JSON.parse(init.body)
      return resp({ id: 'r1', displayName: 'x', ...body })
    }
    if (isRuleId && method === 'DELETE') {
      return resp({}, true, 204)
    }
    if (/\/messageRules$/.test(u) && method === 'POST') {
      const body = JSON.parse(init.body)
      return resp({ id: 'r-new', ...body })
    }
    if (/\/messageRules$/.test(u) && method === 'GET') {
      return resp({ value: [{ id: 'r0', sequence: 2 }, { id: 'r9', sequence: 5 }] })
    }
    return resp({ error: `unexpected ${u}` }, false, 500)
  }
}

async function testOutlook() {
  console.log('\nOutlook rules:')
  installOutlookFetch()
  clearTokenCache()

  check(outlookAdapter.filterAvailability(outlookCtx).available === true, 'outlook filterAvailability true with creds')
  check(typeof outlookAdapter.updateFilter === 'function', 'outlook exposes updateFilter (Graph supports PATCH)')

  // create delete: conditions from senderContains, actions delete, sequence maxSeq+1
  const created = await outlookAdapter.createFilter(outlookCtx, { from: 'noreply@x.com', action: 'delete' })
  const postCall = oCalls.find((c) => /\/messageRules$/.test(c.url) && c.init && c.init.method === 'POST')
  const body = JSON.parse(postCall.init.body)
  check(JSON.stringify(body.conditions.senderContains) === JSON.stringify(['noreply@x.com']), 'outlook --from -> senderContains')
  check(body.actions.delete === true, "outlook 'delete' -> actions.delete true")
  check(body.sequence === 6, 'outlook create sets sequence = maxSeq+1 (5+1)')
  check(typeof body.displayName === 'string' && body.displayName.length > 0, 'outlook create auto-names the rule')
  check(created.id === 'r-new', 'outlook create returns new id')

  // archive -> moveToFolder archive
  installOutlookFetch()
  await outlookAdapter.createFilter(outlookCtx, { subject: 'Newsletter', action: 'archive' })
  let b = JSON.parse(oCalls.find((c) => /\/messageRules$/.test(c.url) && c.init && c.init.method === 'POST').init.body)
  check(b.actions.moveToFolder === 'archive', "outlook 'archive' -> moveToFolder archive")
  check(JSON.stringify(b.conditions.subjectContains) === JSON.stringify(['Newsletter']), 'outlook --subject -> subjectContains')

  // create with no action throws
  let threw = false
  try {
    await outlookAdapter.createFilter(outlookCtx, { from: 'a@x.com' })
  } catch { threw = true }
  check(threw, 'outlook create with no action throws')

  // update: action-only PATCH sends actions, not conditions
  installOutlookFetch()
  const upd = await outlookAdapter.updateFilter(outlookCtx, 'r1', { action: 'markRead' })
  const patchCall = oCalls.find((c) => /\/messageRules\/r1/.test(c.url) && c.init && c.init.method === 'PATCH')
  const pbody = JSON.parse(patchCall.init.body)
  check(pbody.actions.markAsRead === true, "outlook update 'markRead' -> actions.markAsRead")
  check(!('conditions' in pbody), 'outlook action-only update does NOT wipe conditions (no conditions in PATCH)')
  check(upd.id === 'r1', 'outlook updateFilter returns record')

  // list
  installOutlookFetch()
  const list = await outlookAdapter.listFilters(outlookCtx)
  check(Array.isArray(list) && list.length === 2, 'outlook listFilters returns records')

  // get
  installOutlookFetch()
  const one = await outlookAdapter.getFilter(outlookCtx, 'r1')
  check(one.id === 'r1' && /markRead/.test(one.summary), 'outlook getFilter returns record w/ summary')

  // delete
  installOutlookFetch()
  await outlookAdapter.deleteFilter(outlookCtx, 'r1')
  check(
    Boolean(oCalls.find((c) => /\/messageRules\/r1/.test(c.url) && c.init && c.init.method === 'DELETE')),
    'outlook deleteFilter issues DELETE'
  )
}

async function main() {
  await testGmail()
  await testOutlook()
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
