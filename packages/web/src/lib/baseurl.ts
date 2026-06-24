import { headers } from 'next/headers'

/**
 * Resolve the app's own base URL for same-origin server-side fetches.
 * Used by server actions so dashboard mutations go THROUGH the protected
 * API routes (with the admin key injected server-side, never in the browser).
 */
export function getBaseUrl(): string {
  const h = headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'https'
  if (host) return `${proto}://${host}`
  // Fallbacks for build/preview contexts.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}
