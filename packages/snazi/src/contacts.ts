/**
 * macOS Contacts (AddressBook) name enrichment — DISPLAY METADATA ONLY.
 *
 * Reads the local macOS AddressBook SQLite DB(s) read-only to build a
 * Map<normalizedAddress, displayName> so the serve host can attach a
 * `contact_name` to each sender it reports. This is purely cosmetic.
 *
 * SECURITY INVARIANTS (must hold everywhere this module is used):
 *   1. `contact_name` is DISPLAY-ONLY. It MUST NEVER influence approval
 *      status, the read gate, or routing. Reading message text stays gated
 *      solely by `status === 'approved'` over in server.ts/handleRead.
 *   2. A contact name is UNTRUSTED display text: every name is stripped of
 *      control characters and length-capped (see sanitizeContactName) exactly
 *      like the server's parseName/NAME_CTRL_RE handling, so it can never carry
 *      a terminal/log-injection payload. It is never executed or interpreted.
 *   3. If Contacts is unavailable (no DB, no permission, better-sqlite3
 *      missing, or non-macOS) every export DEGRADES to "empty" and NEVER
 *      throws. The gate keeps working with zero Contacts access.
 *
 * This mirrors chatdb.ts: better-sqlite3 (a native module) is required LAZILY
 * inside functions, and the DB path honors env overrides so tests can point at
 * a synthetic AddressBook:
 *   - SNAZI_ADDRESSBOOK_DB  : a single .abcddb file (used directly; tests).
 *   - SNAZI_ADDRESSBOOK_DIR : base AddressBook dir to scan (defaults to the
 *                             real ~/Library/Application Support/AddressBook).
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { normalizeAddress } from './address'

// Keep in sync with server.ts MAX_NAME_LEN / parseName: a contact name is the
// same kind of untrusted, length-capped, control-char-free display text.
const MAX_CONTACT_NAME_LEN = 64
// eslint-disable-next-line no-control-regex
const NAME_CTRL_RE = /[\u0000-\u001f\u007f]/g

/**
 * Sanitize a raw Contacts name into safe display text, or null if there is
 * nothing usable left. Strips ALL control chars (defends terminal/log
 * injection) and hard-caps the length. Mirrors the server's name handling —
 * the difference is we STRIP rather than reject, so one weird contact never
 * breaks enrichment for everyone else.
 */
export function sanitizeContactName(raw: string | null | undefined): string | null {
  if (raw == null) return null
  // Remove control chars first, then collapse surrounding whitespace.
  const stripped = String(raw).replace(NAME_CTRL_RE, '').trim()
  if (stripped === '') return null
  const capped = stripped.slice(0, MAX_CONTACT_NAME_LEN).trim()
  return capped === '' ? null : capped
}

/** Default macOS AddressBook base directory. */
function defaultAddressBookDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'AddressBook'
  )
}

/**
 * Resolve every AddressBook .abcddb file to union across. Honors env overrides.
 * Never throws — returns [] on any filesystem hiccup.
 *
 * Real layout (any/all may exist):
 *   <base>/AddressBook-v22.abcddb
 *   <base>/Sources/<UUID>/AddressBook-v22.abcddb   (one per account/source)
 */
export function addressBookDbPaths(): string[] {
  try {
    const single = process.env.SNAZI_ADDRESSBOOK_DB
    if (single && single.trim() !== '') {
      return fs.existsSync(single) ? [single] : []
    }
    const base =
      process.env.SNAZI_ADDRESSBOOK_DIR &&
      process.env.SNAZI_ADDRESSBOOK_DIR.trim() !== ''
        ? process.env.SNAZI_ADDRESSBOOK_DIR
        : defaultAddressBookDir()

    const found: string[] = []
    const topLevel = path.join(base, 'AddressBook-v22.abcddb')
    if (fs.existsSync(topLevel)) found.push(topLevel)

    const sourcesDir = path.join(base, 'Sources')
    let sources: string[] = []
    try {
      sources = fs.readdirSync(sourcesDir)
    } catch {
      sources = []
    }
    for (const sub of sources) {
      const p = path.join(sourcesDir, sub, 'AddressBook-v22.abcddb')
      if (fs.existsSync(p)) found.push(p)
    }
    // Deterministic union order so "first non-empty name wins" is stable.
    return [...new Set(found)].sort()
  } catch {
    return []
  }
}

/** Lazy native require — only loaded when we actually touch Contacts. */
function loadSqlite(): typeof import('better-sqlite3') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('better-sqlite3')
}

/** Last 10 digits of an address, or '' if it isn't a >=10-digit phone. */
function last10(address: string): string {
  const digits = address.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : ''
}

/**
 * An immutable lookup over the local Contacts. `get()` returns a sanitized
 * display name or null — NEVER throws. Phone matching is robust: exact on the
 * normalized E.164, then a fall back to the last 10 digits (for Contacts
 * numbers stored without a country code or that we can't internationalize).
 */
export interface ContactIndex {
  /** Number of distinct normalized addresses indexed. */
  readonly size: number
  /** Sanitized display name for an address, or null if unknown. */
  get(address: string | null | undefined): string | null
}

/** Empty index used on every failure/degradation path. */
const EMPTY_INDEX: ContactIndex = {
  size: 0,
  get() {
    return null
  },
}

function makeIndex(
  byNorm: Map<string, string>,
  byLast10: Map<string, string>
): ContactIndex {
  return {
    size: byNorm.size,
    get(address: string | null | undefined): string | null {
      const norm = normalizeAddress(address)
      if (norm === '') return null
      const exact = byNorm.get(norm)
      if (exact) return exact
      // Phone fallback: match by trailing 10 digits. This MUST be restricted to
      // phone-like inputs: an email such as "john5551234567@gmail.com" still
      // contains >=10 digits, and without this guard it would false-match a
      // phone contact's trailing-10 key — attaching a TRUSTED contact name to an
      // UNTRUSTED email address (a decide-time display-spoofing vector). Emails
      // resolve by exact normalized address ONLY.
      if (norm.includes('@')) return null
      const tail = last10(norm)
      if (tail !== '') {
        const byTail = byLast10.get(tail)
        if (byTail) return byTail
      }
      return null
    },
  }
}

interface RecordRow {
  Z_PK: number
  ZFIRSTNAME: string | null
  ZLASTNAME: string | null
  ZORGANIZATION: string | null
  ZNICKNAME: string | null
}

/** Compose a record's display name: "First Last" -> nickname -> organization. */
function recordDisplayName(r: RecordRow): string | null {
  const first = (r.ZFIRSTNAME ?? '').trim()
  const last = (r.ZLASTNAME ?? '').trim()
  const full = `${first} ${last}`.trim()
  if (full !== '') return full
  const nick = (r.ZNICKNAME ?? '').trim()
  if (nick !== '') return nick
  const org = (r.ZORGANIZATION ?? '').trim()
  if (org !== '') return org
  return null
}

/**
 * Index one AddressBook DB into the provided maps. "First non-empty name wins":
 * we never overwrite an existing key, so union order (sorted db paths, then
 * Z_PK order) is deterministic. Best-effort: any failure on a single DB is
 * swallowed so the rest still contribute.
 */
function indexOneDb(
  dbPath: string,
  byNorm: Map<string, string>,
  byLast10: Map<string, string>
): void {
  const Database = loadSqlite()
  let db: import('better-sqlite3').Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const records = db
      .prepare(
        'SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME FROM ZABCDRECORD'
      )
      .all() as RecordRow[]

    const nameByPk = new Map<number, string>()
    for (const r of records) {
      const name = sanitizeContactName(recordDisplayName(r))
      if (name) nameByPk.set(r.Z_PK, name)
    }

    const addKey = (
      map: Map<string, string>,
      key: string,
      name: string
    ): void => {
      if (key === '') return
      if (!map.has(key)) map.set(key, name) // first non-empty wins
    }

    // Phones — normalize, plus a last-10 fallback key.
    const phones = db
      .prepare(
        'SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL'
      )
      .all() as { ZOWNER: number | null; ZFULLNUMBER: string | null }[]
    for (const p of phones) {
      if (p.ZOWNER == null) continue
      const name = nameByPk.get(p.ZOWNER)
      if (!name) continue
      const norm = normalizeAddress(p.ZFULLNUMBER)
      addKey(byNorm, norm, name)
      addKey(byLast10, last10(norm), name)
    }

    // Emails — normalize (trim+lowercase).
    const emails = db
      .prepare(
        'SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL'
      )
      .all() as { ZOWNER: number | null; ZADDRESS: string | null }[]
    for (const e of emails) {
      if (e.ZOWNER == null) continue
      const name = nameByPk.get(e.ZOWNER)
      if (!name) continue
      addKey(byNorm, normalizeAddress(e.ZADDRESS), name)
    }
  } catch {
    // Schema variance, locked DB, missing permission — skip this source.
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Build a ContactIndex from every available local AddressBook DB.
 * NEVER throws — returns an empty index when Contacts can't be read for ANY
 * reason (non-macOS, no DB, no permission, better-sqlite3 missing). Callers
 * should treat a miss as `contact_name: null` and carry on.
 */
export function buildContactIndex(): ContactIndex {
  try {
    const paths = addressBookDbPaths()
    if (paths.length === 0) return EMPTY_INDEX
    const byNorm = new Map<string, string>()
    const byLast10 = new Map<string, string>()
    for (const p of paths) indexOneDb(p, byNorm, byLast10)
    if (byNorm.size === 0) return EMPTY_INDEX
    return makeIndex(byNorm, byLast10)
  } catch {
    return EMPTY_INDEX
  }
}

/**
 * Non-throwing readability probe (mirrors chatdb.probeChatDb). Reports whether
 * at least one AddressBook DB exists and can be opened+queried read-only.
 * Purely diagnostic — enrichment itself always degrades silently.
 */
export function probeContacts(): { ok: boolean; reason?: string } {
  try {
    const paths = addressBookDbPaths()
    if (paths.length === 0) {
      return { ok: false, reason: 'No macOS AddressBook database found.' }
    }
    let Database: typeof import('better-sqlite3')
    try {
      Database = loadSqlite()
    } catch (e) {
      return {
        ok: false,
        reason: `better-sqlite3 unavailable: ${String(
          e instanceof Error ? e.message : e
        )}`,
      }
    }
    for (const p of paths) {
      let db: import('better-sqlite3').Database | undefined
      try {
        db = new Database(p, { readonly: true, fileMustExist: true })
        db.prepare('SELECT 1 FROM ZABCDRECORD LIMIT 1').get()
        return { ok: true }
      } catch {
        // try the next source
      } finally {
        try {
          db?.close()
        } catch {
          // ignore
        }
      }
    }
    return {
      ok: false,
      reason:
        'AddressBook database(s) present but not readable (grant Contacts / Full Disk Access).',
    }
  } catch (e) {
    return {
      ok: false,
      reason: `Contacts probe failed: ${String(
        e instanceof Error ? e.message : e
      )}`,
    }
  }
}
