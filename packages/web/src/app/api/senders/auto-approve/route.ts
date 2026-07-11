import { userFromRequest, unauthorized } from '@/lib/auth'
import { autoApproveIfEnabled } from '@/lib/data'
import { normalizeAddress } from '@/lib/address'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * POST /api/senders/auto-approve
 * body: { channel, address }
 *
 * Called by the serve daemon after a successful outbound send. If the owner's
 * `auto_approve_on_send` flag is TRUE, the recipient is upserted to 'approved'
 * on that channel's sender list so the agent can read their reply without a
 * manual approve step. If the flag is FALSE, this is a silent no-op.
 *
 * Authenticated by the per-user READ token (same as other CLI endpoints).
 * This is the ONE approved path where a READ-token request can cause an
 * approval - safe because the owner explicitly opted in via the dashboard.
 */
export async function POST(req: Request) {
  const user = await userFromRequest(req)
  if (!user) return unauthorized()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const b = (body ?? {}) as { channel?: unknown; address?: unknown }
  const channel = typeof b.channel === 'string' ? b.channel.trim() : ''
  const address = normalizeAddress(typeof b.address === 'string' ? b.address : null)

  if (!channel || !address) {
    return Response.json(
      { error: 'channel and address are required.' },
      { status: 400 }
    )
  }

  try {
    const result = await autoApproveIfEnabled(user.id, channel, address)
    return Response.json(result)
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
