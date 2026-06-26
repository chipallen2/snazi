/**
 * Password hashing with Node's built-in scrypt (no external dependency).
 *
 * NODE-ONLY: imports `node:crypto`, so this must only be used from server
 * actions and route handlers running in the Node.js runtime — NEVER from the
 * edge middleware. (The middleware only deals with signed session tokens via
 * lib/session.ts, which is pure Web Crypto.)
 *
 * Stored format: `scrypt$<saltHex>$<derivedKeyHex>`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const KEYLEN = 64
// scrypt cost params. N must be a power of two; these are a reasonable balance
// for an interactive login on serverless.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const dk = scryptSync(password, salt, KEYLEN, SCRYPT_OPTS)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}

/** Constant-time verify. Returns false on any malformed stored value. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[1], 'hex')
    expected = Buffer.from(parts[2], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const dk = scryptSync(password, salt, expected.length, SCRYPT_OPTS)
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}
