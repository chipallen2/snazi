/**
 * Shortcode generation for compact /decide links.
 *
 * A shortcode is an opaque handle stored server-side (sna_decide_shortcodes)
 * that maps back to a full signed capability link. It carries NO authority of
 * its own — the stored HMAC signature is re-verified downstream — so the only
 * requirement is that codes are hard to guess and rarely collide.
 *
 * 8 chars over a 36-symbol alphabet = 36^8 ≈ 2.8e12 possibilities, so random
 * collisions are vanishingly rare (and the caller retries on the unique-key
 * conflict anyway). Uses Web Crypto (crypto.getRandomValues) so it runs in both
 * the edge runtime and Node.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const CODE_LEN = 8

/** Generate a random 8-char [a-z0-9] shortcode. */
export function generateShortcode(): string {
  const arr = new Uint8Array(CODE_LEN)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[arr[i] % ALPHABET.length]
  }
  return out
}
