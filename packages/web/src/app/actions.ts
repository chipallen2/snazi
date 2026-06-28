'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { normalizeAddress } from '@/lib/address'
import {
  SESSION_COOKIE,
  verifySessionToken,
  resolveDecideOwner,
} from '@/lib/session'
import { upsertSender, deleteSender, updateLabel } from '@/lib/data'
import type { SenderStatus } from '@/lib/types'

/**
 * Server actions for the dashboard.
 *
 * Each action is independently POST-able, so it re-checks authorization itself
 * (never trusting the page/middleware gate) and writes through the owner-scoped
 * data layer (lib/data.ts) so a tenant can only ever mutate their own list.
 */

/** Return the logged-in user's id, or throw. */
async function requireOwner(): Promise<string> {
  const id = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  if (!id) throw new Error('Unauthorized.')
  return id
}

function parseSenderStatus(raw: string): SenderStatus | null {
  if (raw === 'approved' || raw === 'denied') return raw
  return null
}

export async function addSender(formData: FormData) {
  const owner = await requireOwner()

  const channel_id = String(formData.get('channel_id') || '').trim()
  const sender_address = normalizeAddress(String(formData.get('sender_address') || ''))
  const label = String(formData.get('label') || '').trim()
  const status = parseSenderStatus(String(formData.get('status') || 'approved'))

  if (!channel_id || !sender_address || !status) return

  await upsertSender(owner, {
    channel_id,
    sender_address,
    label: label || null,
    status,
  })
  revalidatePath('/')
}

export async function setStatus(
  channel_id: string,
  sender_address: string,
  status: SenderStatus
) {
  const owner = await requireOwner()
  if (!parseSenderStatus(status)) return

  await upsertSender(owner, {
    channel_id,
    sender_address: normalizeAddress(sender_address),
    status,
  })
  revalidatePath('/')
}

/**
 * Decision from the /decide deep-link page.
 *
 * Authorized by EITHER a valid signed-link proof (owner + exp + sig carried in
 * the form) OR a dashboard session. The signed link determines its own owner
 * (the signature covers it), so a one-tap Allow/Block link writes to exactly
 * the account that minted it and cannot be forged or retargeted.
 */
export async function decideStatus(formData: FormData) {
  const channel_id = String(formData.get('channel_id') || 'imessage').trim() || 'imessage'
  const sender_address = normalizeAddress(String(formData.get('sender_address') || ''))
  const label = String(formData.get('label') || '').trim()
  const status = parseSenderStatus(String(formData.get('status') || ''))
  const ownerParam = String(formData.get('owner') || '').trim()
  const exp = Number(formData.get('exp'))
  const sig = String(formData.get('sig') || '')

  if (!sender_address || !status) return

  // Resolve the owner to write to via the SAME logic the /decide page used to
  // render this form: a valid signed link wins (it carries its own owner);
  // otherwise fall back to the logged-in session user. This keeps the page and
  // the action from ever disagreeing about which tenant a decision lands on.
  const sessionUserId = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  const owner = await resolveDecideOwner({
    ownerParam,
    channel: channel_id,
    sender: sender_address,
    exp,
    sig,
    sessionUserId,
  })
  if (!owner) throw new Error('Unauthorized.')

  await upsertSender(owner, {
    channel_id,
    sender_address,
    label: label || null,
    status,
    decided_by: 'decide-link',
  })
  revalidatePath('/')
  revalidatePath('/decide')

  const params = new URLSearchParams({
    done: status === 'approved' ? 'allow' : 'block',
  })
  const displayName = label || sender_address
  if (displayName) params.set('name', displayName)
  redirect(`/?${params.toString()}`)
}

export async function removeSender(channel_id: string, sender_address: string) {
  const owner = await requireOwner()
  await deleteSender(owner, channel_id, normalizeAddress(sender_address))
  revalidatePath('/')
}

const MAX_LABEL_LEN = 64
// eslint-disable-next-line no-control-regex
const LABEL_CTRL_RE = /[\u0000-\u001f\u007f]/

/** Set or change the display name on an existing sender (never touches status). */
export async function renameSender(
  channel_id: string,
  sender_address: string,
  formData: FormData
) {
  const owner = await requireOwner()
  const label = String(formData.get('label') || '').trim()
  if (!label) return
  if (label.length > MAX_LABEL_LEN) return
  if (LABEL_CTRL_RE.test(label)) return

  const updated = await updateLabel(
    owner,
    channel_id,
    normalizeAddress(sender_address),
    label
  )
  if (!updated) return
  revalidatePath('/')
}
