#!/usr/bin/env node
/**
 * Address-normalization parity test for the CLI side.
 *
 * These vectors MUST match packages/web/test/address.test.ts exactly: the web
 * (write) side and the CLI (check) side have to agree byte-for-byte, or a
 * sender can be "approved" yet have the gate stay shut. If you change one
 * package's normalizeAddress, change BOTH and update these vectors in lockstep.
 *
 * Run:  npm run build && node test/address.test.cjs
 * Exits nonzero on failure.
 */
let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// Exercise the DEFAULT country code ("1") deterministically.
delete process.env.SNAZI_DEFAULT_COUNTRY_CODE
const { normalizeAddress } = require('../dist/address.js')

function eq(input, expected) {
  const got = normalizeAddress(input)
  check(got === expected, `normalizeAddress(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`)
}

// Email: trim + lowercase.
eq('  Foo.Bar@Example.COM ', 'foo.bar@example.com')

// E.164 passthrough + formatting stripped.
eq('+15551234567', '+15551234567')
eq('+1 (555) 123-4567', '+15551234567')

// Bare national + CC-prefixed numbers promote to E.164.
eq('5551234567', '+15551234567')
eq('(555) 123-4567', '+15551234567')
eq('15551234567', '+15551234567')
eq('1-555-123-4567', '+15551234567')
eq('1.555.123.4567', '+15551234567')

// URL-decoded "+" (leading space) restored.
eq(' 15551234567', '+15551234567')

// Every common US format collapses to ONE key.
const variants = [
  '+15551234567',
  '+1 (555) 123-4567',
  '15551234567',
  '5551234567',
  '(555) 123-4567',
  '1.555.123.4567',
]
const keys = new Set(variants.map(normalizeAddress))
check(keys.size === 1 && keys.has('+15551234567'), 'all US format variants collapse to +15551234567')

// Un-internationalizable inputs stay digit-only (no bad prefix).
eq('12345', '12345')

// Empty / non-phone.
eq('', '')
eq(null, '')
eq(undefined, '')
eq('   ', '')
eq('not-a-number', 'not-a-number')

// Configurable country code.
process.env.SNAZI_DEFAULT_COUNTRY_CODE = '44'
eq('7700900123', '+447700900123')
eq('447700900123', '+447700900123')
delete process.env.SNAZI_DEFAULT_COUNTRY_CODE

const { validateRecipientAddress } = require('../dist/address.js')

function throws(fn, msg) {
  try {
    fn()
    check(false, `${msg} (expected throw)`)
  } catch (e) {
    check(true, msg)
  }
}

check(validateRecipientAddress('5551234567') === '+15551234567', 'validateRecipientAddress accepts 10-digit national')
check(validateRecipientAddress('+15551234567') === '+15551234567', 'validateRecipientAddress accepts E.164')
check(validateRecipientAddress('user@example.com') === 'user@example.com', 'validateRecipientAddress accepts email')

throws(() => validateRecipientAddress('12345'), 'validateRecipientAddress rejects short digit-only number')
throws(() => validateRecipientAddress('+123'), 'validateRecipientAddress rejects too-short E.164')
throws(() => validateRecipientAddress('not-a-number'), 'validateRecipientAddress rejects non-phone text')
throws(() => validateRecipientAddress('bad@'), 'validateRecipientAddress rejects malformed email')
throws(() => validateRecipientAddress(''), 'validateRecipientAddress rejects empty')

if (failures === 0) {
  console.log('\nRESULT: PASS')
  process.exit(0)
} else {
  console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
