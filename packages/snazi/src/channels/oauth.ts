/**
 * Tiny OAuth2 "refresh token -> access token" helper shared by the email
 * channel adapters (Gmail, Outlook).
 *
 * We never run an interactive consent flow here: the user supplies a long-lived
 * refresh token (plus client id/secret) in their LOCAL config, and we exchange
 * it for a short-lived access token on demand. Tokens are cached in memory for
 * the life of the process (helps `snazi serve`) and never written to disk.
 *
 * Uses the global `fetch` (Node 18+), so the package pulls in no HTTP
 * dependency. Unit tests stub `globalThis.fetch`.
 */

export interface TokenRequest {
  tokenUrl: string
  clientId: string
  clientSecret: string
  refreshToken: string
  /** Optional space-delimited scopes (Microsoft wants them on refresh). */
  scope?: string
  /** Extra form fields some providers require. */
  extra?: Record<string, string>
}

interface CacheEntry {
  token: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
}

const tokenCache = new Map<string, CacheEntry>()

function cacheKey(r: TokenRequest): string {
  return `${r.tokenUrl}|${r.clientId}|${r.refreshToken}`
}

/**
 * Exchange a refresh token for an access token, caching it until ~30s before
 * expiry. Throws a concise error (never leaking the secret) on failure.
 */
export async function getAccessToken(r: TokenRequest): Promise<string> {
  const key = cacheKey(r)
  const hit = tokenCache.get(key)
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token

  const body = new URLSearchParams({
    client_id: r.clientId,
    client_secret: r.clientSecret,
    refresh_token: r.refreshToken,
    grant_type: 'refresh_token',
  })
  if (r.scope) body.set('scope', r.scope)
  for (const [k, v] of Object.entries(r.extra ?? {})) body.set(k, v)

  let res: Response
  try {
    res = await fetch(r.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (e) {
    throw new Error(`OAuth token refresh request failed: ${String(e instanceof Error ? e.message : e)}`)
  }

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok) {
    const why = json.error_description || json.error || `HTTP ${res.status}`
    throw new Error(`OAuth token refresh failed: ${why}`)
  }
  if (!json.access_token) {
    throw new Error('OAuth token refresh returned no access_token.')
  }
  const ttlMs = (Number(json.expires_in) || 3600) * 1000
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + ttlMs })
  return json.access_token
}

/** Drop all cached access tokens. Exposed for tests. */
export function clearTokenCache(): void {
  tokenCache.clear()
}
