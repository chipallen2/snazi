/**
 * Resolve the logged-in account inside server components / server actions.
 * Server-only (reads cookies + Supabase). Returns null when not signed in.
 */
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySessionToken } from './session'
import { getUserById } from './users'
import type { User } from './types'

/** The userId from the session cookie, or null. Cheap (no DB hit). */
export async function currentUserId(): Promise<string | null> {
  return verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
}

/** The full account from the session cookie, or null. */
export async function currentUser(): Promise<User | null> {
  const id = await currentUserId()
  if (!id) return null
  return getUserById(id)
}
