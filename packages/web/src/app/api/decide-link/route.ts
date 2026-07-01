import { userFromRequest, unauthorized } from '@/lib/auth'
import { getBaseUrl } from '@/lib/baseurl'
import { normalizeAddress } from '@/lib/address'
import { signDecide, DECIDE_TTL_MS } from '@/lib/session'
import { createDecideShortcode, ShortcodeCollisionError } from '@/lib/data'
import { generateShortcode } from '@/lib/shortcode'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * GET /api/decide-link?channel=imessage&sender=<addr>&label=<name>
 * → { url, channel, sender, expires_at }
 *
 * Mints a SIGNED, expiring /decide link bound to the CALLING account. This is
 * how an agent (holding only the READ token) produces a one-tap Allow/Block
 * link to send to its owner. Minting a link is NOT a mutation: it only creates
 * a capability the human must tap. The signature covers the owner, so the link
 * can only ever modify the account that minted it.
 *
 * Authenticated by the per-user READ token.
 */
export async function GET(req: Request) {
  const user = await userFromRequest(req)
  if (!user) return unauthorized()

  const url = new URL(req.url)
  const channel = (url.searchParams.get('channel') || 'imessage').trim() || 'imessage'
  const sender = normalizeAddress(url.searchParams.get('sender'))
  const label = (url.searchParams.get('label') || '').trim()

  if (!sender) {
    return Response.json({ error: 'sender is required.' }, { status: 400 })
  }

  let exp: number
  let sig: string
  try {
    ;({ exp, sig } = await signDecide(user.id, channel, sender))
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }

  // Persist a short handle for the signed capability and hand back the compact
  // `/decide?s=<code>` URL. The long inline URL still resolves (backward compat),
  // but the short form is what we return so SMS-length links stay tiny. The
  // shortcode stores the SAME sig, so it grants no extra authority — /decide
  // re-verifies the HMAC either way.
  let code = ''
  const MAX_TRIES = 5
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const candidate = generateShortcode()
    try {
      await createDecideShortcode({
        code: candidate,
        owner_id: user.id,
        channel,
        sender,
        label: label || null,
        exp,
        sig,
      })
      code = candidate
      break
    } catch (e) {
      // A code collision is rare and benign — just try a new one. Any other
      // error is a real failure and should surface.
      if (e instanceof ShortcodeCollisionError) continue
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      )
    }
  }
  if (!code) {
    return Response.json(
      { error: 'Could not allocate a unique shortcode; please retry.' },
      { status: 500 }
    )
  }

  const link = `${getBaseUrl()}/decide?s=${code}`

  return Response.json({
    url: link,
    code,
    channel,
    sender,
    expires_at: new Date(exp).toISOString(),
    ttl_ms: DECIDE_TTL_MS,
  })
}
