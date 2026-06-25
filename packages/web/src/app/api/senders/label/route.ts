import { getSupabase } from '@/lib/supabase'
import { requireApiKey, unauthorized } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

// A label is human-readable DISPLAY metadata only. Cap length and reject
// control chars (defends terminal/log injection). It NEVER implies approval.
const MAX_LABEL_LEN = 64
// eslint-disable-next-line no-control-regex
const LABEL_CTRL_RE = /[\u0000-\u001f\u007f]/

/**
 * PATCH /api/senders/label
 * body: { channel_id, sender_address, label }
 *
 * Sets the display label of an EXISTING sender. Authorized by the READ key
 * (SOUP_NAZI_API_KEY) — NOT the admin key — because a label is non-privileged
 * display metadata that cannot open the gate.
 *
 * SECURITY INVARIANTS (do not change without re-reviewing the gate model):
 *   - UPDATE only. It NEVER upserts/inserts, so the read path can never create
 *     a new sender row (which could otherwise be used to influence the list).
 *   - It NEVER touches `status`. Approval stays admin-key/dashboard-only.
 *   - If the sender is not already on the list, 0 rows update -> 404. You must
 *     decide on a sender (via /decide) before they can be named; the name then
 *     travels with the /decide link.
 */
export async function PATCH(req: Request) {
  if (!requireApiKey(req, 'SOUP_NAZI_API_KEY')) return unauthorized()

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

  const { channel_id, sender_address, label } = body

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

  const supabase = getSupabase()
  // UPDATE only — never upsert. `status` is deliberately untouched.
  const { data, error } = await supabase
    .from('sna_senders')
    .update({ label: trimmed })
    .eq('channel_id', channel_id)
    .eq('sender_address', sender_address)
    .select()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  if (!data || data.length === 0) {
    return Response.json(
      {
        error:
          'Sender not on the list. Decide on them first (the name travels with the /decide link).',
      },
      { status: 404 }
    )
  }

  return Response.json({ sender: data[0] })
}
