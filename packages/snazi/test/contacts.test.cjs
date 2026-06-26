#!/usr/bin/env node
/**
 * Unit test for the macOS Contacts (AddressBook) enrichment module.
 *
 * Builds a SYNTHETIC AddressBook sqlite (the Z* tables snazi reads), points
 * SNAZI_ADDRESSBOOK_DB at it, and asserts:
 *   - a FORMATTED Contacts number "(760) 672-1109" enriches sender
 *     "+17606721109" (normalize parity),
 *   - last-10-digit fallback works when Contacts stores a number WITHOUT a
 *     country code,
 *   - email match works (case-insensitive),
 *   - unknown number/email -> null,
 *   - "first non-empty name wins" determinism,
 *   - nickname/organization fallbacks for nameless records,
 *   - control chars in a Contacts name are STRIPPED (display-injection defense),
 *   - missing DB -> empty index, NO throw,
 *   - non-existent override path -> empty index, NO throw.
 *
 * Run:  npm run build && node test/contacts.test.cjs
 * Exits nonzero on failure.
 */
const Database = require('better-sqlite3')
const os = require('os')
const path = require('path')
const fs = require('fs')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// --- Build a synthetic AddressBook .abcddb --------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snazi-contacts-'))
const dbPath = path.join(tmpDir, 'AddressBook-v22.abcddb')

{
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZORGANIZATION TEXT,
      ZNICKNAME TEXT
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZFULLNUMBER TEXT
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZADDRESS TEXT
    );
  `)
  const rec = db.prepare(
    'INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME) VALUES (?, ?, ?, ?, ?)'
  )
  const phone = db.prepare(
    'INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)'
  )
  const email = db.prepare(
    'INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)'
  )

  // 1: First+Last, phone stored in formatted US style.
  rec.run(1, 'Jenny', 'Tutone', null, null)
  phone.run(1, '(760) 672-1109')
  email.run(1, 'Jenny.Tutone@Example.COM')

  // 2: Org-only record (no first/last/nick) -> falls back to organization.
  rec.run(2, null, null, 'Acme Plumbing', null)
  phone.run(2, '+1 555-867-5309')

  // 3: Nickname-only record -> falls back to nickname.
  rec.run(3, null, null, null, 'Coach')
  // Stored WITHOUT a country code -> exercises last-10-digit fallback.
  phone.run(3, '(415) 555-0000')

  // 4: Name with embedded control chars -> must be STRIPPED on read.
  rec.run(4, 'Bad\u0007Guy', 'Ev\u001bil', null, null)
  phone.run(4, '+13105551234')

  // 5: Two records claim the SAME normalized number; FIRST (lower Z_PK) wins.
  rec.run(5, 'First', 'Winner', null, null)
  phone.run(5, '+12025550111')
  rec.run(6, 'Second', 'Loser', null, null)
  phone.run(6, '202-555-0111')

  // 7: Record with NO usable name at all -> must be skipped (no crash, no key).
  rec.run(7, null, null, null, null)
  phone.run(7, '+19998887777')

  // 8: GENUINE last-10-only case. Contact stored with a DIFFERENT country code
  // (+44...) so its normalized form is +447606721234, which does NOT equal the
  // US query +17606721234 by exact match — they only share the trailing 10
  // digits 7606721234. This actually exercises the byLast10 fallback (unlike a
  // bare national number, which normalize promotes to the same +1 key).
  rec.run(8, 'Last', 'TenOnly', null, null)
  phone.run(8, '+447606721234')

  // 9: EMAIL-COLLISION trap. A phone contact whose trailing 10 digits are
  // 5551234567; we must NOT let an email that happens to contain those digits
  // inherit this trusted name (decide-time spoofing defense).
  rec.run(9, 'Trusted', 'Friend', null, null)
  phone.run(9, '+15551234567')

  db.close()
}

// --- Point the module at the synthetic DB ----------------------------------
delete process.env.SNAZI_ADDRESSBOOK_DIR
delete process.env.SNAZI_DEFAULT_COUNTRY_CODE
process.env.SNAZI_ADDRESSBOOK_DB = dbPath

const { buildContactIndex, probeContacts, sanitizeContactName } = require('../dist/contacts.js')

// --- sanitizeContactName unit checks ---------------------------------------
check(sanitizeContactName('Jenny Tutone') === 'Jenny Tutone', 'sanitize keeps clean name')
check(sanitizeContactName('  Bad\u0007Guy  ') === 'BadGuy', 'sanitize strips control chars + trims')
check(sanitizeContactName('\u0000\u001f') === null, 'sanitize -> null when only control chars')
check(sanitizeContactName(null) === null, 'sanitize handles null')
check(
  typeof sanitizeContactName('x'.repeat(200)) === 'string' &&
    sanitizeContactName('x'.repeat(200)).length === 64,
  'sanitize caps length at 64'
)

// --- Build the index and exercise matching ---------------------------------
const idx = buildContactIndex()
check(idx.size > 0, `index built with ${idx.size} entries`)

// Formatted Contacts number enriches the E.164 sender (normalize parity).
check(idx.get('+17606721109') === 'Jenny Tutone', 'formatted "(760) 672-1109" enriches +17606721109')
// And the reverse: a formatted query also resolves (both go through normalize).
check(idx.get('(760) 672-1109') === 'Jenny Tutone', 'formatted query also resolves')

// Email match, case-insensitive.
check(idx.get('jenny.tutone@example.com') === 'Jenny Tutone', 'email match (case-insensitive)')
check(idx.get('JENNY.TUTONE@EXAMPLE.COM') === 'Jenny Tutone', 'email match upper-cased query')

// Organization fallback.
check(idx.get('+15558675309') === 'Acme Plumbing', 'org-only record -> organization name')

// Nickname fallback + last-10 fallback (Contacts had no country code).
check(idx.get('+14155550000') === 'Coach', 'nickname fallback + last-10 match (no CC in Contacts)')

// Control chars stripped from the stored display name.
check(idx.get('+13105551234') === 'BadGuy Evil', 'control chars stripped from contact name')

// Deterministic: first non-empty name wins on duplicate normalized number.
check(idx.get('+12025550111') === 'First Winner', 'first non-empty name wins on duplicate number')

// Nameless record contributes no key.
check(idx.get('+19998887777') === null, 'record with no usable name -> null (skipped)')

// GENUINE last-10 fallback: query +17606721234 (US) vs contact +447606721234
// (UK). No exact byNorm match; resolves ONLY via the shared trailing 10 digits.
check(
  idx.get('+447606721234') === 'Last TenOnly',
  '(sanity) UK contact resolves by its own exact normalized form'
)
check(
  idx.get('+17606721234') === 'Last TenOnly',
  'last-10 fallback matches across differing country codes (real fallback, not exact)'
)

// NEGATIVE email-collision: an email containing the phone's trailing 10 digits
// must NOT inherit the phone contact's name. Last-10 fallback is phone-only.
check(
  idx.get('john5551234567@gmail.com') === null,
  'email containing a phone contact\'s 10 digits does NOT inherit its name (no false match)'
)
check(
  idx.get('+15551234567') === 'Trusted Friend',
  'the phone form of that same number STILL resolves correctly (exact match intact)'
)

// Unknown -> null.
check(idx.get('+10000000000') === null, 'unknown number -> null')
check(idx.get('nobody@nowhere.test') === null, 'unknown email -> null')
check(idx.get('') === null, 'empty address -> null')
check(idx.get(null) === null, 'null address -> null')

// probeContacts on a real readable DB.
const probe = probeContacts()
check(probe.ok === true, 'probeContacts ok on synthetic DB')

// --- Missing DB -> empty index, NO throw -----------------------------------
process.env.SNAZI_ADDRESSBOOK_DB = path.join(tmpDir, 'does-not-exist.abcddb')
let emptyIdx
let threw = false
try {
  emptyIdx = buildContactIndex()
} catch {
  threw = true
}
check(!threw, 'missing DB does NOT throw')
check(emptyIdx && emptyIdx.size === 0, 'missing DB -> empty index (size 0)')
check(emptyIdx && emptyIdx.get('+17606721109') === null, 'missing DB -> get() returns null')
const probeMissing = probeContacts()
check(probeMissing.ok === false && typeof probeMissing.reason === 'string', 'probeContacts !ok on missing DB (with reason)')

// --- Cleanup + verdict -----------------------------------------------------
delete process.env.SNAZI_ADDRESSBOOK_DB
try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {}

if (failures === 0) {
  console.log('\nRESULT: PASS')
  process.exit(0)
} else {
  console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
