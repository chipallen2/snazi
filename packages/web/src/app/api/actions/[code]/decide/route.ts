import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { runActionDecision } from '@/lib/action-service'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * POST /api/actions/[code]/decide
 * Body: { decision: 'approved' | 'denied' }
 * → { ok, status, summary, ... }
 *
 * Programmatic sibling of the /decide page's decideAction server action. Both
 * delegate to runActionDecision, which is the single authority: it re-verifies
 * the action's stored HMAC signature (or a matching dashboard session),
 * enforces expiry + pending status, then executes + notifies on approve.
 *
 * The `code` (shortcode) is itself the unguessable capability handle; there is
 * no bearer-token requirement here because approval authority comes from
 * possessing the signed link (re-verified server-side) or a logged-in session —
 * exactly like the sender /decide flow. The READ token can MINT actions but must
 * never be able to approve them, so it is intentionally NOT accepted here.
 */
export async function POST(
  req: Request,
  { params }: { params: { code: string } }
) {
  const code = (params.code || '').trim()
  if (!code) {
    return Response.json({ error: 'Missing action code.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const raw = String((body as { decision?: unknown })?.decision || '').trim()
  const decision = raw === 'approved' ? 'approved' : raw === 'denied' ? 'denied' : null
  if (!decision) {
    return Response.json(
      { error: "decision must be 'approved' or 'denied'." },
      { status: 400 }
    )
  }

  const sessionUserId = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  const outcome = await runActionDecision({ code, decision, sessionUserId })

  if (!outcome.ok) {
    const httpStatus =
      outcome.code === 'not_found'
        ? 404
        : outcome.code === 'unauthorized'
          ? 403
          : 409 // expired / already decided
    return Response.json(outcome, { status: httpStatus })
  }
  return Response.json(outcome)
}
