#!/usr/bin/env node
/**
 * Channel adapter registry tests.
 *
 * Verifies the cross-platform contract that lets snazi run anywhere while a
 * channel that can't read on this OS (e.g. iMessage off macOS) degrades to a
 * clear "unavailable" instead of crashing:
 *   - the registry exposes the iMessage adapter and rejects unknown ids
 *   - resolveReadableAdapter returns an error (never throws) for unknown ids
 *   - availability() is honest about THIS platform:
 *       * darwin  -> unavailable (with a reason) when chat.db is missing
 *       * others  -> unavailable with a macOS-only reason, WITHOUT requiring
 *                    the native better-sqlite3 module
 *
 * Run:  npm run build && node test/channels.test.cjs
 * Exits nonzero on failure.
 */
const os = require('os')
const path = require('path')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

const {
  getAdapter,
  listAdapters,
  resolveReadableAdapter,
} = require('../dist/channels/index.js')

// --- registry basics -------------------------------------------------------
const im = getAdapter('imessage')
check(Boolean(im), 'imessage adapter is registered')
check(im && im.displayName === 'iMessage', 'imessage adapter displayName is iMessage')
check(
  im && Array.isArray(im.platforms) && im.platforms.includes('darwin'),
  'imessage adapter targets the darwin platform'
)
check(getAdapter('totally-unknown') === undefined, 'unknown channel id -> undefined')
check(
  listAdapters().some((a) => a.id === 'imessage'),
  'listAdapters() includes imessage'
)

// --- email channel TYPES are registered + run on any platform ---------------
for (const type of ['gmail', 'outlook']) {
  const a = getAdapter(type)
  check(Boolean(a), `${type} adapter is registered`)
  check(a && Array.isArray(a.platforms) && a.platforms.length === 0, `${type} runs on any platform`)
  check(Boolean(a && a.sendMessage), `${type} supports sending`)
  // Unconfigured (no auth) -> unavailable with a helpful reason, never a throw.
  const ctx = { id: type, type, name: type, auth: {} }
  const av = a.availability(ctx)
  check(av.available === false && /not configured/i.test(av.reason || ''), `${type} unconfigured -> unavailable`)
}

// An instance can be resolved by slug to its type's adapter when a config maps
// the slug -> type, with credentials available unavailability is the only gate.
{
  const cfg = { channels: [{ id: 'gmail-work', type: 'gmail', name: 'Work', auth: {} }] }
  const r = resolveReadableAdapter('gmail-work', cfg)
  // No creds -> resolves the adapter but reports unavailable via error.
  check(Boolean(r.error) && /not configured/i.test(r.error || ''), 'slug resolves to type adapter; unconfigured -> error')
}

// --- resolveReadableAdapter never throws on an unknown channel -------------
const unknown = resolveReadableAdapter('totally-unknown')
check(
  Boolean(unknown.error) && !unknown.adapter,
  'unknown channel resolves to a helpful error (no throw)'
)
check(
  /Known channels/.test(unknown.error || ''),
  'unknown-channel error lists the known channels'
)

// --- platform-aware availability ------------------------------------------
if (process.platform === 'darwin') {
  // Point at a nonexistent chat.db so the probe fails deterministically
  // regardless of the dev machine's real Messages history / FDA state.
  process.env.SNAZI_CHAT_DB = path.join(
    os.tmpdir(),
    `snazi-does-not-exist-${Date.now()}.db`
  )
  const av = im.availability()
  check(av.available === false, 'darwin: missing chat.db -> unavailable')
  check(
    typeof av.reason === 'string' && av.reason.length > 0,
    'darwin: unavailable result carries a reason'
  )
  const r = resolveReadableAdapter('imessage')
  check(
    Boolean(r.error) && !r.adapter,
    'darwin: resolve imessage errors when chat.db is missing'
  )
  delete process.env.SNAZI_CHAT_DB
} else {
  const av = im.availability()
  check(av.available === false, 'non-darwin: imessage is unavailable')
  check(
    /macOS/i.test(av.reason || ''),
    'non-darwin: reason explains iMessage is macOS-only'
  )
  const r = resolveReadableAdapter('imessage')
  check(
    Boolean(r.error) && /not available/i.test(r.error || ''),
    'non-darwin: resolve imessage returns an unavailable error'
  )
}

if (failures === 0) {
  console.log('\nRESULT: PASS')
  process.exit(0)
} else {
  console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
