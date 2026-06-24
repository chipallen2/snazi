import { getSupabase } from '@/lib/supabase'
import { requireApiKey, unauthorized } from '@/lib/auth'
import type { CheckStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

/**
 * GET /api/senders/check?channel=imessage&address=<addr>
 * → { status: 'approved' | 'denied' | 'unknown' }
 *
 * The Mac wrapper CLI calls this BEFORE revealing any message content.
 * Read-protected by SOUP_NAZI_API_KEY.
 */
export async function GET(req: Request) {
  if (!requireApiKey(req, 'SOUP_NAZI_API_KEY')) return unauthorized()

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel')
  const address = url.searchParams.get('address')

  if (!channel || !address) {
    return Response.json(
      { error: 'channel and address query params are required.' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_senders')
    .select('status')
    .eq('channel_id', channel)
    .eq('sender_address', address)
    .maybeSingle()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const status: CheckStatus = (data?.status as CheckStatus) ?? 'unknown'
  return Response.json({ status })
}
