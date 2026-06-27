/**
 * Account data access. Server-only (uses the service-role Supabase client and
 * node:crypto via lib/password). Never import from the edge middleware.
 *
 * password_hash never leaves this module: the public helpers return the
 * `User` type, which omits it.
 */
import { randomBytes } from 'crypto'
import { getSupabase } from './supabase'
import { hashPassword, verifyPassword } from './password'
import type { User } from './types'

const PUBLIC_COLS = 'id,email,read_token,created_at'

export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase()
}

function genReadToken(): string {
  return randomBytes(32).toString('hex')
}

/** Create an account. Returns the new user or a user-safe error message. */
export async function createUser(
  email: string,
  password: string
): Promise<{ user?: User; error?: string }> {
  const e = normalizeEmail(email)
  if (!e || !e.includes('@') || e.length > 254) {
    return { error: 'A valid email address is required.' }
  }
  if (typeof password !== 'string' || password.length < 8) {
    return { error: 'Password must be at least 8 characters.' }
  }
  if (password.length > 200) {
    return { error: 'Password is too long.' }
  }

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_users')
    .insert({
      email: e,
      password_hash: hashPassword(password),
      read_token: genReadToken(),
    })
    .select(PUBLIC_COLS)
    .single()

  if (error) {
    // 23505 = unique_violation (email already registered).
    if ((error as { code?: string }).code === '23505') {
      return { error: 'An account with that email already exists.' }
    }
    return { error: error.message }
  }

  // Seed a default iMessage channel instance so the dashboard isn't empty and
  // the slug 'imessage' (used by existing CLI configs + /decide links) exists.
  // Best-effort: a failure here must not fail signup.
  const user = data as User
  await supabase
    .from('sna_channels')
    .insert({ owner_id: user.id, type: 'imessage', name: 'iMessage', slug: 'imessage' })
    .then(undefined, () => undefined)

  return { user }
}

/**
 * Verify an email+password login. Returns the user on success, else null.
 * Always runs the password KDF (even when the email is unknown, against a
 * dummy hash) so timing does not leak whether the email exists.
 */
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'))

export async function verifyLogin(
  email: string,
  password: string
): Promise<User | null> {
  const e = normalizeEmail(email)
  const supabase = getSupabase()
  const { data } = await supabase
    .from('sna_users')
    .select('id,email,read_token,created_at,password_hash')
    .eq('email', e)
    .maybeSingle()

  const stored = (data as { password_hash?: string } | null)?.password_hash ?? DUMMY_HASH
  const ok = verifyPassword(password, stored)
  if (!ok || !data) return null
  const { password_hash: _omit, ...user } = data as User & { password_hash: string }
  return user as User
}

/** Resolve a CLI read token to its owning account. Null if no match. */
export async function findUserByToken(token: string): Promise<User | null> {
  if (!token || token.length < 16) return null
  const supabase = getSupabase()
  const { data } = await supabase
    .from('sna_users')
    .select(PUBLIC_COLS)
    .eq('read_token', token)
    .maybeSingle()
  return (data as User) ?? null
}

export async function getUserById(id: string): Promise<User | null> {
  if (!id) return null
  const supabase = getSupabase()
  const { data } = await supabase
    .from('sna_users')
    .select(PUBLIC_COLS)
    .eq('id', id)
    .maybeSingle()
  return (data as User) ?? null
}

/**
 * Mint a fresh READ token for an account, invalidating the previous one.
 * Use this if the token is leaked: any agent/CLI using the old token stops
 * working immediately and must be reconfigured with the new value. Returns the
 * updated user (with the new token), or null if the account no longer exists.
 */
export async function rotateReadToken(userId: string): Promise<User | null> {
  if (!userId) return null
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_users')
    .update({ read_token: genReadToken() })
    .eq('id', userId)
    .select(PUBLIC_COLS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as User) ?? null
}
