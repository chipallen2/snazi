'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { rotateReadToken } from '@/lib/users'

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
