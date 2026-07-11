'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { rotateReadToken } from '@/lib/users'
import { setAutoApproveOnSend } from '@/lib/data'

/**
 * Rotate the logged-in account's CLI READ token.
 *
 * Independently POST-able, so it re-verifies the session itself (never trusts
 * the page/middleware gate) and only ever rotates the CALLER's own token. The
 * old token stops working the instant this commits.
 */
export async function rotateToken() {
  const userId = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  if (!userId) throw new Error('Unauthorized.')
  await rotateReadToken(userId)
  revalidatePath('/account')
}

/**
 * Toggle the per-account `auto_approve_on_send` setting.
 * When enabled, anyone the agent sends a message TO is automatically approved
 * on that channel's sender list, so their reply can be read without a manual
 * approve step. Re-verifies the session itself.
 */
export async function toggleAutoApprove(formData: FormData) {
  const userId = await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  if (!userId) throw new Error('Unauthorized.')
  const enabled = formData.get('enabled') === 'true'
  await setAutoApproveOnSend(userId, enabled)
  revalidatePath('/account')
}
