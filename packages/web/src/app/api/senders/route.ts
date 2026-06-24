import { getSupabase } from '@/lib/supabase'
import { requireApiKey, unauthorized } from '@/lib/auth'
import type { SenderStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * GET /api/senders?channel=imessage
 * → full sender list (optionally filtered by channel).
 * Read-protected by SOUP_NAZI_API_KEY.
 */
export async function GET(req: Request) {
  if (!requireApiKey(req, 'SOUP_NAZI_API_KEY')) return unauthorized()

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel')

  const supabase = getSupabase()
  let query = supabase
    .from('sna_senders')
    .select('*')
    .order('decided_at', { ascending: false })

  if (channel) query = query.eq('channel_id', channel)

  const { data, error } = await query
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ senders: data })
}

/**
 * POST /api/senders
 * body: { channel_id, sender_address, label?, status }
 * Upserts a sender to 'approved' or 'denied'.
 * Mutate-protected by SOUP_NAZI_ADMIN_KEY.
 */
export async function POST(req: Request) {
  if (!requireApiKey(req, 'SOUP_NAZI_ADMIN_KEY')) return unauthorized()

  let body: {
    channel_id?: string
    sender_address?: string
    label?: string
    status?: SenderStatus
    decided_by?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { channel_id, sender_address, label, status, decided_by } = body

  if (!channel_id || !sender_address) {
    return Response.json(
      { error: 'channel_id and sender_address are required.' },
      { status: 400 }
    )
  }
  const finalStatus: SenderStatus = status === 'denied' ? 'denied' : 'approved'

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_senders')
    .upsert(
      {
        channel_id,
        sender_address,
        label: label ?? null,
        status: finalStatus,
        decided_at: new Date().toISOString(),
        decided_by: decided_by ?? 'dashboard',
      },
      { onConflict: 'channel_id,sender_address' }
    )
    .select()
    .single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ sender: data })
}

/**
 * DELETE /api/senders
 * body: { channel_id, sender_address }
 * Removes a sender from the list entirely (status becomes 'unknown').
 * Mutate-protected by SOUP_NAZI_ADMIN_KEY.
 */
export async function DELETE(req: Request) {
  if (!requireApiKey(req, 'SOUP_NAZI_ADMIN_KEY')) return unauthorized()

  let body: { channel_id?: string; sender_address?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { channel_id, sender_address } = body
  if (!channel_id || !sender_address) {
    return Response.json(
      { error: 'channel_id and sender_address are required.' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const { error } = await supabase
    .from('sna_senders')
    .delete()
    .eq('channel_id', channel_id)
    .eq('sender_address', sender_address)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
