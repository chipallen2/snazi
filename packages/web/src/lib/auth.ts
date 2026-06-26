/**
 * Per-user API token auth for route handlers.
 *
 * The Mac CLI / agent presents its account's READ token via either:
 *   - x-api-key: <token>
 *   - Authorization: Bearer <token>
 *
 * The token resolves to the owning account; routes then scope every query to
 * that owner via lib/data.ts. The token is READ-scoped: it can check/list/label
 * and mint /decide links, but can NEVER approve/deny (those require a dashboard
 * session or a signed /decide link).
 */
import { findUserByToken } from './users'
import type { User } from './types'

function extractToken(req: Request): string {
  return (
    req.headers.get('x-api-key') ||
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    ''
  )
}

/** Resolve the request's token to an account, or null if missing/invalid. */
export async function userFromRequest(req: Request): Promise<User | null> {
  const token = extractToken(req)
  if (!token) return null
  return findUserByToken(token)
}

/** Standard 401 response for missing/invalid tokens. */
export function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized.' }, { status: 401 })
}
