/**
 * Session + signed-link helpers for the dashboard.
 *
 * Two things are signed with one secret (SOUP_NAZI_AUTH_SECRET):
 *   1. The dashboard session cookie (set after a correct password login).
 *   2. /decide capability links (so they can be sent over SMS/Slack without
 *      exposing the whole dashboard, and can't be forged or replayed forever).
 *
 * Implemented with Web Crypto (crypto.subtle) and no Node-only APIs (no
 * Buffer) so the SAME module runs in both the edge middleware and Node server
 * actions. Fails CLOSED: a missing secret makes every verify return false.
 */

export const SESSION_COOKIE = 'snazi_session'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Lifetime of a /decide capability link. These are bearer tokens sent over
 * SMS/Slack, so they are FORWARDABLE for their whole lifetime — keep that
 * window short to limit the blast radius of a leaked/forwarded link. Default is
 * 24h (enough to tap a link the morning after it's sent); override with
 * SNAZI_DECIDE_TTL_MS (milliseconds) if you need longer.
 */
export const DECIDE_TTL_MS = ttlFromEnv('SNAZI_DECIDE_TTL_MS', 24 * 60 * 60 * 1000)

/** Read a positive-integer millisecond TTL from an env var, else the fallback. */
function ttlFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  if (!raw) return fallbackMs
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs
}

const encoder = new TextEncoder()

function getSecret(): string | null {
  const s = process.env.SOUP_NAZI_AUTH_SECRET
  return s && s.length > 0 ? s : null
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Constant-time string compare (both hex digests, equal length expected). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return toHex(sig)
}

// --- Dashboard session -----------------------------------------------------

/**
 * Mint a session token of the form `<userId>.<expMs>.<hmac>`, binding the
 * cookie to a specific account. Throws if misconfigured.
 */
export async function createSessionToken(
  userId: string,
  ttlMs = SESSION_TTL_MS
): Promise<string> {
  const secret = getSecret()
  if (!secret) {
    throw new Error('SOUP_NAZI_AUTH_SECRET not configured.')
  }
  if (!userId) throw new Error('userId is required to mint a session.')
  const exp = Date.now() + ttlMs
  const sig = await hmacHex(secret, `session.${userId}.${exp}`)
  return `${userId}.${exp}.${sig}`
}

/**
 * Verify a session token. Returns the userId it is bound to if well-formed,
 * unexpired, and correctly signed — otherwise null. (Callers that only need a
 * boolean can check the truthiness of the result.)
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<string | null> {
  const secret = getSecret()
  if (!secret || !token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, expStr, sig] = parts
  if (!userId) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp <= Date.now()) return null
  const expected = await hmacHex(secret, `session.${userId}.${exp}`)
  return timingSafeEqual(sig, expected) ? userId : null
}

// --- Signed /decide links --------------------------------------------------

/**
 * Canonical string a /decide signature covers. Includes the OWNER so a signed
 * link can only mutate the account that minted it. Deliberately EXCLUDES the
 * label: the label is non-privileged display metadata that may be substituted
 * with the value already on the list, so signing it would cause spurious
 * verification failures. Owner + channel + sender + expiry are what matter.
 */
function decidePayload(
  owner: string,
  channel: string,
  sender: string,
  exp: number
): string {
  return `decide.${owner}.${channel}.${sender}.${exp}`
}

/** Sign a /decide link. Returns the expiry + signature to embed in the URL. */
export async function signDecide(
  owner: string,
  channel: string,
  sender: string,
  ttlMs = DECIDE_TTL_MS
): Promise<{ exp: number; sig: string }> {
  const secret = getSecret()
  if (!secret) {
    throw new Error('SOUP_NAZI_AUTH_SECRET not configured.')
  }
  if (!owner) throw new Error('owner is required to sign a /decide link.')
  const exp = Date.now() + ttlMs
  const sig = await hmacHex(secret, decidePayload(owner, channel, sender, exp))
  return { exp, sig }
}

/** Verify a /decide link's signature + expiry for a given owner. */
export async function verifyDecide(
  owner: string,
  channel: string,
  sender: string,
  exp: number,
  sig: string | undefined | null
): Promise<boolean> {
  const secret = getSecret()
  if (!secret || !sig || !owner) return false
  if (!Number.isFinite(exp) || exp <= Date.now()) return false
  const expected = await hmacHex(secret, decidePayload(owner, channel, sender, exp))
  return timingSafeEqual(sig, expected)
}

/**
 * Resolve WHICH account a /decide action operates on. Shared by the /decide page
 * (to render the form + look up status) and the decide server action (to
 * authorize the write) so the two can NEVER disagree on the owner.
 *
 * A valid signed capability link WINS: it carries its own owner, so a one-tap
 * Allow/Block link always decides for exactly the account that minted it — even
 * when a DIFFERENT account happens to be logged in on the same browser. (Earlier
 * this preferred the session, so a logged-in user tapping someone else's link
 * silently wrote the decision to THEIR OWN list — the wrong tenant.)
 *
 * Only when there is no valid link do we fall back to the logged-in session
 * user, who is deciding for their own account from the dashboard. Returns null
 * when neither path authorizes a write.
 */
export async function resolveDecideOwner(input: {
  ownerParam: string | null | undefined
  channel: string
  sender: string
  exp: number
  sig: string | null | undefined
  sessionUserId: string | null | undefined
}): Promise<string | null> {
  const { ownerParam, channel, sender, exp, sig, sessionUserId } = input
  const trimmedOwner = (ownerParam ?? '').trim()
  if (trimmedOwner && (await verifyDecide(trimmedOwner, channel, sender, exp, sig))) {
    return trimmedOwner
  }
  return sessionUserId || null
}
