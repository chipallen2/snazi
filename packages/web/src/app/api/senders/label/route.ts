import { userFromRequest, unauthorized } from '@/lib/auth'
import { updateLabel } from '@/lib/data'
import { normalizeAddress } from '@/lib/address'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

// Label validation limits — keep in sync with snazi/src/server.ts (MAX_NAME_LEN,
// NAME_CTRL_RE). The serve POST /label body field is `name`; this route uses `label`.
const MAX_LABEL_LEN = 64
// eslint-disable-next-line no-control-regex
const LABEL_CTRL_RE = /[\u0000-\u001f\u007f]/

/**
 * PATCH /api/senders/label
 * body: { channel_id, sender_address, label }
 *
 * Sets the display label of an EXISTING sender on the calling account's list.
 * Authenticated by the per-user READ token (not a mutation of approval state).
 *
 * SECURITY INVARIANTS (do not change without re-reviewing the gate model):
 *   - UPDATE only (via lib/data.updateLabel). It NEVER upserts/inserts, so the
 *     read path can never create a new sender row.
 *   - It NEVER touches `status`. Approval stays session/decide-link-only.
 *   - Scoped to the token's owner, so it can only label that account's senders.
 *   - If the sender is not already on the list, 0 rows update -> 404.
 */
export async function PATCH(req: Request) {
  const user = await userFromRequest(req)
  if (!user) return unauthorized()

  let body: {
    channel_id?: string
    sender_address?: string
    label?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { channel_id, label } = body
  const sender_address = normalizeAddress(body.sender_address)

  if (!channel_id || !sender_address) {
    return Response.json(
      { error: 'channel_id and sender_address are required.' },
      { status: 400 }
    )
  }
  if (typeof label !== 'string' || label.trim() === '') {
    return Response.json(
      { error: 'label is required and must be a non-empty string.' },
      { status: 400 }
    )
  }
  const trimmed = label.trim()
  if (trimmed.length > MAX_LABEL_LEN) {
    return Response.json(
      { error: `label too long (max ${MAX_LABEL_LEN}).` },
      { status: 400 }
    )
  }
  if (LABEL_CTRL_RE.test(trimmed)) {
    return Response.json({ error: 'label contains invalid characters.' }, { status: 400 })
  }

  try {
    const updated = await updateLabel(user.id, channel_id, sender_address, trimmed)
    if (!updated) {
      return Response.json(
        {
          error:
            'Sender not on the list. Decide on them first (the name travels with the /decide link).',
        },
        { status: 404 }
      )
    }
    return Response.json({ sender: updated })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
