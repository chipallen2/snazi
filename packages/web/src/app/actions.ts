'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
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

/**
 * Decision from the /decide deep-link page.
 *
 * Reads channel/sender/label/status from the posted form, upserts via the
 * protected API (admin key injected server-side, never in the browser), then
 * redirects to the home page with a `decided` flag so it can render a clear
 * confirmation banner. Used by the one-tap Allow/Block deep-link card.
 */
export async function decideStatus(formData: FormData) {
  const channel_id = String(formData.get('channel_id') || 'imessage').trim()
  const sender_address = String(formData.get('sender_address') || '').trim()
  const label = String(formData.get('label') || '').trim()
  const status = String(formData.get('status') || '') as SenderStatus

  if (!sender_address || (status !== 'approved' && status !== 'denied')) return

  const res = await fetch(`${getBaseUrl()}/api/senders`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      channel_id,
      sender_address,
      label: label || null,
      status,
      decided_by: 'decide-link',
    }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`decideStatus failed: ${res.status}`)
  revalidatePath('/')
  revalidatePath('/decide')

  // Send the user back to the home page with a confirmation banner instead of
  // leaving them on the /decide card with the buttons still showing.
  const params = new URLSearchParams({
    decided: status === 'approved' ? 'approved' : 'denied',
    sender: sender_address,
  })
  if (label) params.set('label', label)
  redirect(`/?${params.toString()}`)
}

/**
 * Rename (set/change the friendly label of) an existing sender.
 *
 * Reuses the same protected /api/senders upsert path as setStatus, with the
 * admin key injected server-side only. The current status is passed in so the
 * rename never accidentally flips approved/denied.
 */
export async function renameSender(
  channel_id: string,
  sender_address: string,
  status: SenderStatus,
  formData: FormData
) {
  const label = String(formData.get('label') || '').trim()
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
  if (!res.ok) throw new Error(`renameSender failed: ${res.status}`)
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
