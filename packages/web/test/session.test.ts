import { beforeAll, describe, expect, it } from 'vitest'
import {
  createSessionToken,
  verifySessionToken,
  signDecide,
  verifyDecide,
  resolveDecideOwner,
} from '../src/lib/session'

// The session module reads SOUP_NAZI_AUTH_SECRET lazily (per call), so setting
// it before exercising the helpers is enough.
beforeAll(() => {
  process.env.SOUP_NAZI_AUTH_SECRET = 'test-secret-please-ignore'
})

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CHANNEL = 'imessage'
const SENDER = '+15551234567'

describe('session token', () => {
  it('round-trips and is bound to its user', async () => {
    const token = await createSessionToken(ACCOUNT_A)
    expect(await verifySessionToken(token)).toBe(ACCOUNT_A)
  })

  it('rejects a tampered token', async () => {
    const token = await createSessionToken(ACCOUNT_A)
    const tampered = token.replace(ACCOUNT_A, ACCOUNT_B)
    expect(await verifySessionToken(tampered)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await createSessionToken(ACCOUNT_A, -1)
    expect(await verifySessionToken(token)).toBeNull()
  })

  it('rejects junk', async () => {
    expect(await verifySessionToken(undefined)).toBeNull()
    expect(await verifySessionToken('')).toBeNull()
    expect(await verifySessionToken('a.b.c')).toBeNull()
  })
})

describe('signed /decide links', () => {
  it('verifies a freshly signed link', async () => {
    const { exp, sig } = await signDecide(ACCOUNT_A, CHANNEL, SENDER)
    expect(await verifyDecide(ACCOUNT_A, CHANNEL, SENDER, exp, sig)).toBe(true)
  })

  it('is bound to the owner — A\'s signature does NOT verify for B', async () => {
    const { exp, sig } = await signDecide(ACCOUNT_A, CHANNEL, SENDER)
    expect(await verifyDecide(ACCOUNT_B, CHANNEL, SENDER, exp, sig)).toBe(false)
  })

  it('is bound to channel + sender + expiry', async () => {
    const { exp, sig } = await signDecide(ACCOUNT_A, CHANNEL, SENDER)
    expect(await verifyDecide(ACCOUNT_A, 'gmail', SENDER, exp, sig)).toBe(false)
    expect(await verifyDecide(ACCOUNT_A, CHANNEL, '+19998887777', exp, sig)).toBe(false)
    expect(await verifyDecide(ACCOUNT_A, CHANNEL, SENDER, exp + 1, sig)).toBe(false)
  })

  it('rejects expired links', async () => {
    const { exp, sig } = await signDecide(ACCOUNT_A, CHANNEL, SENDER, -1)
    expect(await verifyDecide(ACCOUNT_A, CHANNEL, SENDER, exp, sig)).toBe(false)
  })
})

describe('resolveDecideOwner (the /decide owner-binding fix)', () => {
  it('a valid signed link wins even when a DIFFERENT account is logged in', async () => {
    // This is the regression: logged in as A, tapping a link minted for B must
    // decide for B (the link owner), NOT silently write to A's list.
    const { exp, sig } = await signDecide(ACCOUNT_B, CHANNEL, SENDER)
    const owner = await resolveDecideOwner({
      ownerParam: ACCOUNT_B,
      channel: CHANNEL,
      sender: SENDER,
      exp,
      sig,
      sessionUserId: ACCOUNT_A,
    })
    expect(owner).toBe(ACCOUNT_B)
  })

  it('falls back to the session user when there is no valid link', async () => {
    const owner = await resolveDecideOwner({
      ownerParam: '',
      channel: CHANNEL,
      sender: SENDER,
      exp: 0,
      sig: '',
      sessionUserId: ACCOUNT_A,
    })
    expect(owner).toBe(ACCOUNT_A)
  })

  it('falls back to the session user when the link signature is invalid', async () => {
    const owner = await resolveDecideOwner({
      ownerParam: ACCOUNT_B,
      channel: CHANNEL,
      sender: SENDER,
      exp: Date.now() + 60_000,
      sig: 'deadbeef',
      sessionUserId: ACCOUNT_A,
    })
    expect(owner).toBe(ACCOUNT_A)
  })

  it('uses the link owner for a passwordless (no-session) recipient', async () => {
    const { exp, sig } = await signDecide(ACCOUNT_B, CHANNEL, SENDER)
    const owner = await resolveDecideOwner({
      ownerParam: ACCOUNT_B,
      channel: CHANNEL,
      sender: SENDER,
      exp,
      sig,
      sessionUserId: null,
    })
    expect(owner).toBe(ACCOUNT_B)
  })

  it('returns null when neither a valid link nor a session is present', async () => {
    const owner = await resolveDecideOwner({
      ownerParam: ACCOUNT_B,
      channel: CHANNEL,
      sender: SENDER,
      exp: Date.now() + 60_000,
      sig: 'not-a-real-sig',
      sessionUserId: null,
    })
    expect(owner).toBeNull()
  })
})
