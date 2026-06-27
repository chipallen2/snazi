'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { createChannel, deleteChannel } from '@/lib/data'

/**
 * Server actions for managing channel INSTANCES (named per-user channels).
 *
 * Channel management is dashboard-only (session-authenticated), exactly like
 * approvals: the per-user READ token can never create or delete a channel.
 * Each action re-verifies the session itself and writes only the caller's rows.
 *
 * No credentials are accepted or stored here — OAuth tokens / app passwords
 * live ONLY on the CLI machine. The server stores just name + type.
 */

async function requireOwner(): Promise<string> {
  const id = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  if (!id) throw new Error('Unauthorized.')
  return id
}

export async function addChannel(formData: FormData) {
  const owner = await requireOwner()
  const type = String(formData.get('type') || '').trim()
  const name = String(formData.get('name') || '').trim()
  const slug = String(formData.get('slug') || '').trim()
  if (!type || !name) return
  await createChannel(owner, { type, name, slug: slug || undefined })
  revalidatePath('/channels')
  revalidatePath('/')
}

export async function removeChannel(slug: string) {
  const owner = await requireOwner()
  if (!slug) return
  await deleteChannel(owner, slug)
  revalidatePath('/channels')
  revalidatePath('/')
}
