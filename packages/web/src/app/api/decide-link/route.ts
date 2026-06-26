import { userFromRequest, unauthorized } from '@/lib/auth'
import { getBaseUrl } from '@/lib/baseurl'
import { normalizeAddress } from '@/lib/address'
import { signDecide, DECIDE_TTL_MS } from '@/lib/session'

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

  const params = new URLSearchParams({
    owner: user.id,
    channel,
    sender,
    exp: String(exp),
    sig,
  })
  if (label) params.set('label', label)
  const link = `${getBaseUrl()}/decide?${params.toString()}`

  return Response.json({
    url: link,
    channel,
    sender,
    expires_at: new Date(exp).toISOString(),
    ttl_ms: DECIDE_TTL_MS,
  })
}
