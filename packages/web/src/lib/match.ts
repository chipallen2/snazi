/**
 * Sender-matching precedence — the single source of truth for how an incoming
 * address is matched against approve/deny rows in sna_senders.
 *
 * A sender can be decided at three levels of specificity:
 *   1. EXACT address            e.g. "no_reply@communications.paypal.com"
 *   2. SUBDOMAIN wildcard        e.g. "*@communications.paypal.com"
 *   3. ROOT-domain wildcard      e.g. "*@paypal.com"  (covers all subdomains)
 *
 * The /decide page lets the user Allow/Block at ANY of these levels (the
 * "Allow root domain, including all subdomains" button writes level 3). The
 * gate MUST therefore look up all three, and the MOST SPECIFIC existing row
 * wins (exact > subdomain > root). Before this module existed, checkSender only
 * looked up levels 1 and 2, so a root-domain approval never matched a subdomain
 * sender and the gate stayed shut despite an explicit approval.
 *
 * Keeping this pure + shared means checkSender (the gate) and getSender (the UI
 * display helper) can never disagree.
 */
import { extractEmailDomain, extractRootDomain, domainWildcard } from './address'

/**
 * Ordered list of sender_address strings to look up for an incoming address,
 * MOST specific first: [exact, subdomain wildcard, root-domain wildcard].
 * Deduped, and skips a wildcard that would equal the address itself (so a query
 * for "*@paypal.com" doesn't add itself twice).
 */
export function senderMatchCandidates(address: string): string[] {
  const candidates: string[] = [address]

  const domain = extractEmailDomain(address)
  if (domain) {
    const subWildcard = domainWildcard(domain)
    if (subWildcard !== address) candidates.push(subWildcard)

    const root = extractRootDomain(domain)
    if (root) {
      const rootWildcard = domainWildcard(root)
      if (rootWildcard !== address && !candidates.includes(rootWildcard)) {
        candidates.push(rootWildcard)
      }
    }
  }

  return candidates
}

/**
 * Given the ordered candidate list and the rows fetched for those candidates,
 * return the row for the MOST specific candidate that has one (exact beats
 * subdomain wildcard beats root wildcard), or null. Status is intentionally
 * ignored here: a more-specific decision (approve OR deny) always overrides a
 * broader one.
 */
export function pickMostSpecific<T extends { sender_address: string }>(
  candidates: string[],
  rows: T[]
): T | null {
  for (const candidate of candidates) {
    const row = rows.find((r) => r.sender_address === candidate)
    if (row) return row
  }
  return null
}
