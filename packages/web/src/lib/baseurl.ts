import { headers } from 'next/headers'

/**
 * Resolve the app's own base URL. Used when building absolute /decide links
 * (e.g. the signed one-tap links minted by /api/decide-link).
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
