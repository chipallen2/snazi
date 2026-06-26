import { userFromRequest, unauthorized } from '@/lib/auth'
import { checkSender } from '@/lib/data'
import { normalizeAddress } from '@/lib/address'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * GET /api/senders/check?channel=imessage&address=<addr>
 * → { status: 'approved' | 'denied' | 'unknown' }
 *
 * The Mac wrapper CLI calls this BEFORE revealing any message content.
 * Authenticated by the per-user READ token; scoped to that owner.
 */
export async function GET(req: Request) {
  const user = await userFromRequest(req)
  if (!user) return unauthorized()

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel')
  const address = normalizeAddress(url.searchParams.get('address'))

  if (!channel || !address) {
    return Response.json(
      { error: 'channel and address query params are required.' },
      { status: 400 }
    )
  }

  try {
    const status = await checkSender(user.id, channel, address)
    return Response.json({ status })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
