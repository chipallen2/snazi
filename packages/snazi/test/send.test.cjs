#!/usr/bin/env node
/**
 * iMessage send helper tests (no actual Messages.app calls).
 *
 * Run:  npm run build && node test/send.test.cjs
 */
const { escapeAppleScriptString, probeSendAvailability } = require('../dist/imessage-send.js')
const { resolveSendableAdapter } = require('../dist/channels/index.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

check(
  escapeAppleScriptString('say "hello"') === 'say \\"hello\\"',
  'escapeAppleScriptString quotes'
)
check(
  escapeAppleScriptString('back\\slash') === 'back\\\\slash',
  'escapeAppleScriptString backslashes'
)

const unknown = resolveSendableAdapter('totally-unknown')
check(Boolean(unknown.error) && !unknown.adapter, 'unknown channel -> send error')

if (process.platform === 'darwin') {
  const av = probeSendAvailability()
  check(typeof av.available === 'boolean', 'darwin: probeSendAvailability returns boolean')
  const r = resolveSendableAdapter('imessage')
  check(Boolean(r.adapter?.sendMessage), 'darwin: imessage is sendable when Messages exists')
} else {
  const av = probeSendAvailability()
  check(av.available === false, 'non-darwin: send unavailable')
  check(/macOS/i.test(av.reason || ''), 'non-darwin: reason mentions macOS')
  const r = resolveSendableAdapter('imessage')
  check(Boolean(r.error) && !r.adapter, 'non-darwin: resolve send imessage errors')
}

if (failures === 0) {
  console.log('\nRESULT: PASS')
  process.exit(0)
} else {
  console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
