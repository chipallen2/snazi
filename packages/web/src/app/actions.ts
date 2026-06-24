'use server'

import { revalidatePath } from 'next/cache'
import { getBaseUrl } from '@/lib/baseurl'
import type { SenderStatus } from '@/lib/types'

/**
 * Server actions for the dashboard.
 *
 * These run on the server only and call the protected /api/senders routes
 * with SOUP_NAZI_ADMIN_KEY injected from the environment. The admin key is
 * NEVER sent to the browser. This is how the dashboard "mutates via API
 * routes" while staying secure.
 */
function adminHeaders(): HeadersInit {
  const key = process.env.SOUP_NAZI_ADMIN_KEY
  if (!key) throw new Error('SOUP_NAZI_ADMIN_KEY not configured.')
  return { 'content-type': 'application/json', 'x-api-key': key }
}

export async function addSender(formData: FormData) {
  const channel_id = String(formData.get('channel_id') || '').trim()
  const sender_address = String(formData.get('sender_address') || '').trim()
  const label = String(formData.get('label') || '').trim()
  const status = String(formData.get('status') || 'approved') as SenderStatus

  if (!channel_id || !sender_address) return

  const res = await fetch(`${getBaseUrl()}/api/senders`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      channel_id,
      sender_address,
      label: label || null,
      status,
    }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`addSender failed: ${res.status}`)
  revalidatePath('/')
}

export async function setStatus(
  channel_id: string,
  sender_address: string,
  status: SenderStatus
) {
  const res = await fetch(`${getBaseUrl()}/api/senders`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ channel_id, sender_address, status }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`setStatus failed: ${res.status}`)
  revalidatePath('/')
}

export async function removeSender(
  channel_id: string,
  sender_address: string
) {
  const res = await fetch(`${getBaseUrl()}/api/senders`, {
    method: 'DELETE',
    headers: adminHeaders(),
    body: JSON.stringify({ channel_id, sender_address }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`removeSender failed: ${res.status}`)
  revalidatePath('/')
}
