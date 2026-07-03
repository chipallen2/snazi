/**
 * Schwab API adapter for snazi serve.
 *
 * Handles OAuth token management (access token + refresh) and read-only
 * account/position/transaction queries against the Schwab Trader API.
 *
 * CREDENTIALS: All secrets are read from the macOS Keychain on the serve host
 * (the machine that runs `snazi serve`). They are NEVER stored in config.json
 * or sent to the web tier. The web tier (snazi.dev) never sees Schwab creds;
 * it only mints signed /decide links and records action outcomes.
 *
 * Keychain keys (all under account "goferchip"):
 *   gofer-schwab-client_id
 *   gofer-schwab-client_secret
 *   gofer-schwab-access_token
 *   gofer-schwab-refresh_token
 *   gofer-schwab-expires_at     (Unix ms, as a string)
 *
 * SECURITY:
 *   - Read only. No order-placement path exists in this module.
 *   - Token refresh uses Basic auth (client_id:client_secret) so no other
 *     secret escapes. The refreshed access_token is written back to Keychain.
 *   - All functions throw on error; callers convert to HTTP responses.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const SCHWAB_BASE = 'https://api.schwabapi.com/trader/v1'
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'
const KEYCHAIN_ACCOUNT = 'goferchip'

// ---------------------------------------------------------------------------
// Keychain helpers
// ---------------------------------------------------------------------------

/**
 * Read a single value from macOS Keychain by service name.
 * Returns null if the item is not present (no throw on missing).
 */
async function keychainRead(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s', service,
      '-a', KEYCHAIN_ACCOUNT,
      '-w',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Write (add-or-update) a value in macOS Keychain.
 * Uses `add-generic-password -U` (update if present).
 */
async function keychainWrite(service: string, value: string): Promise<void> {
  await execFileAsync('security', [
    'add-generic-password',
    '-s', service,
    '-a', KEYCHAIN_ACCOUNT,
    '-w', value,
    '-U', // update if the item already exists
  ])
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

export interface SchwabTokens {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix ms
}

/**
 * Load all Schwab credentials from Keychain.
 * Throws a descriptive error if any required credential is absent.
 */
export async function loadSchwabCreds(): Promise<SchwabTokens> {
  const [clientId, clientSecret, accessToken, refreshToken, expiresAtStr] =
    await Promise.all([
      keychainRead('gofer-schwab-client_id'),
      keychainRead('gofer-schwab-client_secret'),
      keychainRead('gofer-schwab-access_token'),
      keychainRead('gofer-schwab-refresh_token'),
      keychainRead('gofer-schwab-expires_at'),
    ])

  const missing: string[] = []
  if (!clientId) missing.push('gofer-schwab-client_id')
  if (!clientSecret) missing.push('gofer-schwab-client_secret')
  if (!accessToken) missing.push('gofer-schwab-access_token')
  if (!refreshToken) missing.push('gofer-schwab-refresh_token')
  if (missing.length) {
    throw new Error(
      `Schwab credentials not found in Keychain: ${missing.join(', ')}. ` +
        `Run: security add-generic-password -s <key> -a ${KEYCHAIN_ACCOUNT} -w <value> -U`
    )
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    accessToken: accessToken!,
    refreshToken: refreshToken!,
    expiresAt: expiresAtStr ? Number(expiresAtStr) : 0,
  }
}

/**
 * Refresh the Schwab access token using the stored refresh token.
 * Updates Keychain with the new access_token (and new refresh_token +
 * expires_at if the server rotates them). Returns the updated token set.
 */
async function refreshAccessToken(creds: SchwabTokens): Promise<SchwabTokens> {
  const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    'base64'
  )
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  })

  const res = await fetch(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    cache: 'no-store',
  } as RequestInit)

  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(
      `Schwab token refresh failed (HTTP ${res.status}): ${detail.slice(0, 200)}`
    )
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  if (!data.access_token) {
    throw new Error('Schwab token refresh returned no access_token.')
  }

  const expiresAt = Date.now() + (data.expires_in ?? 1800) * 1000

  // Persist back to Keychain.
  await keychainWrite('gofer-schwab-access_token', data.access_token)
  await keychainWrite('gofer-schwab-expires_at', String(expiresAt))
  if (data.refresh_token) {
    await keychainWrite('gofer-schwab-refresh_token', data.refresh_token)
  }

  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt,
  }
}

/**
 * Return a valid (non-expired) Schwab access token, refreshing if needed.
 * Adds a 60-second buffer so we never use a token that's about to expire.
 */
export async function getAccessToken(): Promise<string> {
  const creds = await loadSchwabCreds()
  const bufferMs = 60_000
  if (creds.expiresAt > Date.now() + bufferMs) {
    return creds.accessToken
  }
  // Token is expired or about to expire — refresh.
  const refreshed = await refreshAccessToken(creds)
  return refreshed.accessToken
}

// ---------------------------------------------------------------------------
// Schwab API calls
// ---------------------------------------------------------------------------

/** A minimal account shape. Full schema varies by account type. */
export interface SchwabAccount {
  securitiesAccount?: {
    accountNumber?: string
    type?: string
    currentBalances?: Record<string, number>
    positions?: unknown[]
    [key: string]: unknown
  }
  aggregatedBalance?: {
    currentLiquidationValue?: number
    liquidationValue?: number
  }
  [key: string]: unknown
}

/** A minimal transaction shape. */
export interface SchwabTransaction {
  activityId?: number
  time?: string
  type?: string
  status?: string
  subAccount?: string
  tradeDate?: string
  settleDate?: string
  netAmount?: number
  description?: string
  [key: string]: unknown
}

/**
 * GET /accounts?fields=positions
 * Returns all Schwab accounts (with positions) for the authenticated user.
 */
export async function getAccounts(): Promise<SchwabAccount[]> {
  const token = await getAccessToken()
  const res = await fetch(`${SCHWAB_BASE}/accounts?fields=positions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  } as RequestInit)

  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(
      `Schwab GET /accounts failed (HTTP ${res.status}): ${detail.slice(0, 200)}`
    )
  }

  const data = await res.json()
  return Array.isArray(data) ? (data as SchwabAccount[]) : [data as SchwabAccount]
}

/**
 * GET /accounts/{accountNumber}/transactions
 * Returns transactions for the given account between `from` and `to`
 * (ISO 8601 date strings, e.g. "2024-01-01" or "2024-01-01T00:00:00.000Z").
 * `to` defaults to today if omitted.
 */
export async function getTransactions(
  accountNumber: string,
  from: string,
  to?: string
): Promise<SchwabTransaction[]> {
  if (!accountNumber || typeof accountNumber !== 'string') {
    throw new Error('accountNumber is required.')
  }
  if (!from || typeof from !== 'string') {
    throw new Error('from date is required (ISO 8601).')
  }

  const toDate = to ?? new Date().toISOString().slice(0, 10)
  const params = new URLSearchParams({ startDate: from, endDate: toDate })
  const url = `${SCHWAB_BASE}/accounts/${encodeURIComponent(accountNumber)}/transactions?${params}`

  const token = await getAccessToken()
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  } as RequestInit)

  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(
      `Schwab GET /transactions failed (HTTP ${res.status}): ${detail.slice(0, 200)}`
    )
  }

  const data = await res.json()
  return Array.isArray(data) ? (data as SchwabTransaction[]) : [data as SchwabTransaction]
}
