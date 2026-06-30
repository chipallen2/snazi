/**
 * Normalize a sender address so the SAME person resolves to the SAME row
 * whether they were added via the dashboard, a /decide link, the CLI, or read
 * straight out of chat.db.
 *
 * THIS FILE IS KEPT BYTE-FOR-BYTE IN SYNC with packages/snazi/src/address.ts.
 * Writes (dashboard/decide) and checks (CLI/serve) MUST key on identical
 * strings, so if you change one copy, change the other to match.
 *
 * Rules (deterministic — applied identically on write AND on check):
 *   - Email (contains '@'): trimmed + lowercased.
 *   - Phone: reduced to E.164 ("+" + country code + national digits).
 *       * Anything starting with "+" is treated as E.164: "+1 (555) 123-4567"
 *         -> "+15551234567".
 *       * A bare national number is promoted to E.164 using a default country
 *         calling code (SNAZI_DEFAULT_COUNTRY_CODE, default "1" / NANP). chat.db
 *         hands us E.164 ("+1…"), but a human often types "(555) 123-4567";
 *         without promotion the two never match -> "approved but gate shut".
 *         A 10-digit number gets "+<cc>"; a number already prefixed with the CC
 *         (e.g. "1 555 123 4567") just gets the "+".
 *       * Numbers we can't confidently internationalize are left digit-only
 *         (no worse than before) rather than mis-prefixed.
 *
 * A literal "+" in a query string decodes to a space, so an E.164 number can
 * arrive as " 15551234567"; we restore the leading "+" in that case.
 *
 * The default country code is operator-configurable because guessing it is
 * locale-specific; international users should enter full "+" E.164 numbers.
 */
export function normalizeAddress(raw: string | null | undefined): string {
  const original = String(raw ?? '')
  const s = original.trim()
  if (s === '') return ''
  if (s.includes('@')) return s.toLowerCase()

  let plus = s.startsWith('+')
  // A leading space (with no "+") means a literal "+" was decoded away.
  if (!plus && /^\s\d/.test(original)) plus = true

  const digits = s.replace(/\D/g, '')
  if (digits === '') return s // not phone-like; return trimmed original
  if (plus) return `+${digits}`

  // Bare national number → promote to E.164 with the default country code.
  const cc = defaultCountryCode()
  if (digits.length === 10) return `+${cc}${digits}`
  if (cc && digits.length === 10 + cc.length && digits.startsWith(cc)) {
    return `+${digits}`
  }
  return digits // can't confidently internationalize; leave digit-only
}

/** Default country calling code (digits only) used to promote bare numbers. */
function defaultCountryCode(): string {
  return (process.env.SNAZI_DEFAULT_COUNTRY_CODE ?? '1').replace(/\D/g, '')
}

/**
 * Validate and normalize a recipient address for outbound send.
 * Phone numbers must normalize to E.164; emails must look like emails.
 * Throws with a clear message on invalid input.
 */
export function validateRecipientAddress(raw: string | null | undefined): string {
  const original = String(raw ?? '').trim()
  if (!original) {
    throw new Error('Missing recipient.')
  }
  const normalized = normalizeAddress(raw)
  if (!normalized) {
    throw new Error('Missing recipient.')
  }
  if (normalized.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error('Invalid email address.')
    }
    return normalized
  }
  if (!normalized.startsWith('+')) {
    throw new Error(
      'Invalid recipient. Use a phone number (+15551234567) or email address.'
    )
  }
  // E.164: + followed by 7–15 digits (country code never starts with 0).
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new Error(
      'Invalid phone number. Use E.164 (+15551234567) or a 10-digit national number.'
    )
  }
  return normalized
}

/**
 * Extract the domain from an email address, e.g. "user@google.com" →
 * "google.com". Returns null for non-emails (no '@') or a missing/blank domain.
 * Lower-cased + trimmed so it keys identically to normalizeAddress output.
 */
export function extractEmailDomain(address: string): string | null {
  const at = address.indexOf('@')
  if (at < 0) return null
  const domain = address.slice(at + 1).toLowerCase().trim()
  return domain || null
}

/**
 * The wildcard sender_address for a domain, e.g. "google.com" → "*@google.com".
 * Stored in sna_senders.sender_address to approve/deny an ENTIRE domain at once.
 */
export function domainWildcard(domain: string): string {
  return `*@${domain.toLowerCase().trim()}`
}
