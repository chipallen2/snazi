import { userFromRequest, unauthorized } from '@/lib/auth'
import { getBaseUrl } from '@/lib/baseurl'
import { signAction, DECIDE_TTL_MS } from '@/lib/session'
import { createAction, ShortcodeCollisionError } from '@/lib/data'
import { generateShortcode } from '@/lib/shortcode'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

const MAX_TYPE_LEN = 64
const MAX_DESC_LEN = 500
const TYPE_RE = /^[a-z0-9_]+$/i
// Cap the machine payload so a caller can't stuff arbitrarily large JSON into
// the DB / the signed link. Actions are small structured intents.
const MAX_PAYLOAD_BYTES = 8 * 1024
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/**
 * POST /api/action-link
 * Body: { type, payload, description }
 * → { url, code, type, description, expires_at, ttl_ms }
 *
 * Mints a SIGNED, expiring /decide link for a generalized capability ACTION
 * (e.g. a Schwab trade) bound to the CALLING account. This is the action-world
 * analogue of /api/decide-link: creating the link is NOT itself a mutation of
 * anything the owner cares about — it only creates a pending capability the
 * human must tap to approve. The signature covers the owner + shortcode, so the
 * link can only ever act on the account that minted it.
 *
 * Authenticated by the per-user READ token (same as decide-link). The READ
 * token can MINT a pending action but can NEVER approve/execute it — that
 * requires the human tapping the signed /decide link (or a dashboard session).
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
  const b = (body ?? {}) as {
    type?: unknown
    payload?: unknown
    description?: unknown
  }

  const type = typeof b.type === 'string' ? b.type.trim() : ''
  if (!type || type.length > MAX_TYPE_LEN || !TYPE_RE.test(type)) {
    return Response.json(
      { error: 'type is required ([A-Za-z0-9_], <= 64 chars).' },
      { status: 400 }
    )
  }

  const description = typeof b.description === 'string' ? b.description.trim() : ''
  if (!description || description.length > MAX_DESC_LEN || CTRL_RE.test(description)) {
    return Response.json(
      { error: 'description is required (<= 500 chars, no control chars).' },
      { status: 400 }
    )
  }

  if (b.payload == null || typeof b.payload !== 'object' || Array.isArray(b.payload)) {
    return Response.json(
      { error: 'payload is required and must be a JSON object.' },
      { status: 400 }
    )
  }
  const payload = b.payload as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    return Response.json({ error: 'payload too large.' }, { status: 400 })
  }

  // Allocate a unique shortcode, sign owner+code+exp, and persist the pending
  // action. Retry on the rare shortcode collision (same pattern as decide-link).
  const MAX_TRIES = 5
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const code = generateShortcode()
    let exp: number
    let sig: string
    try {
      ;({ exp, sig } = await signAction(user.id, code))
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      )
    }
    try {
      const action = await createAction({
        owner_id: user.id,
        type,
        payload,
        description,
        shortcode: code,
        sig,
        exp,
      })
      const url = `${getBaseUrl()}/decide?a=${code}`
      return Response.json({
        url,
        code,
        type: action.type,
        description: action.description,
        expires_at: new Date(exp).toISOString(),
        ttl_ms: DECIDE_TTL_MS,
      })
    } catch (e) {
      if (e instanceof ShortcodeCollisionError) continue
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      )
    }
  }

  return Response.json(
    { error: 'Could not allocate a unique shortcode; please retry.' },
    { status: 500 }
  )
}
