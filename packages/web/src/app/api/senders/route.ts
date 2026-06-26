import { userFromRequest, unauthorized } from '@/lib/auth'
import { listSenders } from '@/lib/data'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * GET /api/senders?channel=imessage
 * → the calling account's full sender list (optionally filtered by channel).
 *
 * Authenticated by the per-user READ token; scoped to that owner.
 *
 * There is intentionally NO POST/DELETE here: the read token must never be able
 * to mutate the list. Approvals happen via the dashboard (session) or a signed
 * /decide link.
 */
export async function GET(req: Request) {
  const user = await userFromRequest(req)
  if (!user) return unauthorized()

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel') || undefined

  try {
    const senders = await listSenders(user.id, channel)
    return Response.json({ senders })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
