import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAddress, validateRecipientAddress } from '../src/lib/address'

/**
 * These vectors MUST stay in sync with packages/snazi/test/address.test.cjs —
 * the web (write) side and the CLI (check) side have to agree byte-for-byte, or
 * a sender can be "approved" yet have the gate stay shut.
 */
describe('normalizeAddress', () => {
  const prev = process.env.SNAZI_DEFAULT_COUNTRY_CODE
  beforeEach(() => {
    delete process.env.SNAZI_DEFAULT_COUNTRY_CODE // exercise the default ("1")
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.SNAZI_DEFAULT_COUNTRY_CODE
    else process.env.SNAZI_DEFAULT_COUNTRY_CODE = prev
  })

  it('lowercases + trims emails', () => {
    expect(normalizeAddress('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com')
  })

  it('passes through E.164 and strips formatting', () => {
    expect(normalizeAddress('+15551234567')).toBe('+15551234567')
    expect(normalizeAddress('+1 (555) 123-4567')).toBe('+15551234567')
  })

  it('promotes a 10-digit national number to E.164', () => {
    expect(normalizeAddress('5551234567')).toBe('+15551234567')
    expect(normalizeAddress('(555) 123-4567')).toBe('+15551234567')
  })

  it('promotes an 11-digit CC-prefixed number to E.164', () => {
    expect(normalizeAddress('15551234567')).toBe('+15551234567')
    expect(normalizeAddress('1-555-123-4567')).toBe('+15551234567')
  })

  it('all common US formats collapse to ONE key (the chat.db E.164 key)', () => {
    const variants = [
      '+15551234567',
      '+1 (555) 123-4567',
      '15551234567',
      '5551234567',
      '(555) 123-4567',
      '1.555.123.4567',
    ]
    const keys = new Set(variants.map(normalizeAddress))
    expect([...keys]).toEqual(['+15551234567'])
  })

  it('restores a "+" that a query string decoded to a leading space', () => {
    // "+15551234567" in a URL can arrive as " 15551234567".
    expect(normalizeAddress(' 15551234567')).toBe('+15551234567')
  })

  it('honors a configurable default country code', () => {
    process.env.SNAZI_DEFAULT_COUNTRY_CODE = '44'
    expect(normalizeAddress('7700900123')).toBe('+447700900123') // 44 + 10 digits
    expect(normalizeAddress('447700900123')).toBe('+447700900123') // already CC-prefixed
  })

  it('leaves un-internationalizable inputs digit-only (no bad prefix)', () => {
    expect(normalizeAddress('12345')).toBe('12345') // short code
  })

  it('returns "" / trimmed-original for empty + non-phone input', () => {
    expect(normalizeAddress('')).toBe('')
    expect(normalizeAddress(null)).toBe('')
    expect(normalizeAddress(undefined)).toBe('')
    expect(normalizeAddress('   ')).toBe('')
    expect(normalizeAddress('not-a-number')).toBe('not-a-number')
  })
})

describe('validateRecipientAddress', () => {
  const prev = process.env.SNAZI_DEFAULT_COUNTRY_CODE
  beforeEach(() => {
    delete process.env.SNAZI_DEFAULT_COUNTRY_CODE
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.SNAZI_DEFAULT_COUNTRY_CODE
    else process.env.SNAZI_DEFAULT_COUNTRY_CODE = prev
  })

  it('accepts normalized phone numbers and emails', () => {
    expect(validateRecipientAddress('5551234567')).toBe('+15551234567')
    expect(validateRecipientAddress('+15551234567')).toBe('+15551234567')
    expect(validateRecipientAddress('user@example.com')).toBe('user@example.com')
  })

  it('rejects invalid phones and emails', () => {
    expect(() => validateRecipientAddress('12345')).toThrow(/Invalid/)
    expect(() => validateRecipientAddress('+123')).toThrow(/Invalid phone/)
    expect(() => validateRecipientAddress('not-a-number')).toThrow(/Invalid recipient/)
    expect(() => validateRecipientAddress('bad@')).toThrow(/Invalid email/)
    expect(() => validateRecipientAddress('')).toThrow(/Missing recipient/)
  })
})
