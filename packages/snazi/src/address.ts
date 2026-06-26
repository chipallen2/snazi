/**
 * Normalize a sender address so the SAME person resolves to the SAME row
 * whether they were added via the dashboard, a /decide link, the CLI, or read
 * straight out of chat.db.
 *
 * THIS FILE IS KEPT BYTE-FOR-BYTE IN SYNC with packages/web/src/lib/address.ts.
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
