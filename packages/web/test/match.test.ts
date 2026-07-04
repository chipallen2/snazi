import { describe, expect, it } from 'vitest'
import { senderMatchCandidates, pickMostSpecific } from '../src/lib/match'

/**
 * Regression tests for the root-domain-wildcard gate bug: a sender on a
 * SUBDOMAIN (no_reply@communications.paypal.com) must match an approval on the
 * ROOT domain wildcard (*@paypal.com) written by the /decide "Allow root domain,
 * including all subdomains" button. Before the fix the gate only looked up the
 * exact address + the full subdomain wildcard, so the approval never matched.
 */
describe('senderMatchCandidates', () => {
  it('subdomain email → [exact, subdomain wildcard, root wildcard]', () => {
    expect(
      senderMatchCandidates('no_reply@communications.paypal.com')
    ).toEqual([
      'no_reply@communications.paypal.com',
      '*@communications.paypal.com',
      '*@paypal.com',
    ])
  })

  it('multi-level subdomain reduces root to last two labels', () => {
    expect(senderMatchCandidates('support@s.usa.experian.com')).toEqual([
      'support@s.usa.experian.com',
      '*@s.usa.experian.com',
      '*@experian.com',
    ])
  })

  it('gov subdomain → root wildcard *@ca.gov', () => {
    expect(
      senderMatchCandidates('senator.blakespear@outreach.senate.ca.gov')
    ).toEqual([
      'senator.blakespear@outreach.senate.ca.gov',
      '*@outreach.senate.ca.gov',
      '*@ca.gov',
    ])
  })

  it('bare-domain email → no separate root wildcard (root == subdomain)', () => {
    expect(senderMatchCandidates('no-reply@amazonaws.com')).toEqual([
      'no-reply@amazonaws.com',
      '*@amazonaws.com',
    ])
  })

  it('a subdomain wildcard address itself does not duplicate itself', () => {
    // Looking up the wildcard row directly (e.g. dashboard) still gets its root.
    expect(senderMatchCandidates('*@communications.paypal.com')).toEqual([
      '*@communications.paypal.com',
      '*@paypal.com',
    ])
  })

  it('a bare-domain wildcard address only returns itself', () => {
    expect(senderMatchCandidates('*@paypal.com')).toEqual(['*@paypal.com'])
  })

  it('phone / non-email → just the exact address', () => {
    expect(senderMatchCandidates('+15551234567')).toEqual(['+15551234567'])
  })
})

describe('pickMostSpecific', () => {
  const row = (sender_address: string, status = 'approved') => ({
    sender_address,
    status,
  })

  it('root wildcard approval matches a subdomain sender', () => {
    const candidates = senderMatchCandidates(
      'no_reply@communications.paypal.com'
    )
    const rows = [row('*@paypal.com', 'approved')]
    expect(pickMostSpecific(candidates, rows)?.status).toBe('approved')
  })

  it('exact beats subdomain wildcard beats root wildcard', () => {
    const candidates = senderMatchCandidates('a@x.example.com')
    const rows = [
      row('*@example.com', 'denied'),
      row('*@x.example.com', 'denied'),
      row('a@x.example.com', 'approved'),
    ]
    expect(pickMostSpecific(candidates, rows)?.sender_address).toBe(
      'a@x.example.com'
    )
  })

  it('subdomain wildcard beats root wildcard when no exact row', () => {
    const candidates = senderMatchCandidates('a@x.example.com')
    const rows = [
      row('*@example.com', 'approved'),
      row('*@x.example.com', 'denied'),
    ]
    // more specific (subdomain) wins even though it is a DENY over an approve
    expect(pickMostSpecific(candidates, rows)?.sender_address).toBe(
      '*@x.example.com'
    )
  })

  it('a DENIED root wildcard blocks a subdomain sender', () => {
    const candidates = senderMatchCandidates('spam@mail.evil.com')
    const rows = [row('*@evil.com', 'denied')]
    expect(pickMostSpecific(candidates, rows)?.status).toBe('denied')
  })

  it('no matching rows → null (unknown)', () => {
    const candidates = senderMatchCandidates('a@b.example.com')
    expect(pickMostSpecific(candidates, [])).toBeNull()
  })

  it('ignores rows for unrelated addresses', () => {
    const candidates = senderMatchCandidates('a@example.com')
    const rows = [row('*@other.com', 'approved')]
    expect(pickMostSpecific(candidates, rows)).toBeNull()
  })
})
