'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
} from '@/lib/session'
import { createUser, verifyLogin } from '@/lib/users'
import { rateLimit, clientIp } from '@/lib/rateLimit'

// Per-IP auth throttle: a handful of attempts per window, then back off. Tuned
// to be invisible to humans but painful for password-guessing scripts.
const AUTH_MAX_ATTEMPTS = 8
const AUTH_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

/** Only allow same-site relative redirects (never open-redirect to a host). */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

/** Throttle an auth endpoint by client IP. Returns true if the caller is over
 *  the limit and should be turned away. */
function authThrottled(scope: string): boolean {
  const ip = clientIp(headers())
  return !rateLimit(`${scope}:${ip}`, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_MS).ok
}

async function startSession(userId: string, next: string): Promise<void> {
  const token = await createSessionToken(userId, SESSION_TTL_MS)
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
  redirect(next)
}

export async function login(formData: FormData) {
  const email = String(formData.get('email') || '')
  const password = String(formData.get('password') || '')
  const next = safeNext(String(formData.get('next') || '/'))

  if (authThrottled('login')) {
    const params = new URLSearchParams({ error: 'rate' })
    if (next !== '/') params.set('next', next)
    redirect(`/login?${params.toString()}`)
  }

  const user = await verifyLogin(email, password)
  if (!user) {
    const params = new URLSearchParams({ error: '1' })
    if (next !== '/') params.set('next', next)
    redirect(`/login?${params.toString()}`)
  }

  await startSession(user.id, next)
}

export async function signup(formData: FormData) {
  const email = String(formData.get('email') || '')
  const password = String(formData.get('password') || '')
  const next = safeNext(String(formData.get('next') || '/'))

  if (authThrottled('signup')) {
    const params = new URLSearchParams({ error: 'rate' })
    if (next !== '/') params.set('next', next)
    redirect(`/signup?${params.toString()}`)
  }

  const { user, error } = await createUser(email, password)
  if (error || !user) {
    const params = new URLSearchParams({ error: error || 'Could not create account.' })
    if (next !== '/') params.set('next', next)
    redirect(`/signup?${params.toString()}`)
  }

  await startSession(user.id, next)
}

export async function logout() {
  cookies().delete(SESSION_COOKIE)
  redirect('/login')
}
