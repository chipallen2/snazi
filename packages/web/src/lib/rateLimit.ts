/**
 * Tiny in-process fixed-window rate limiter.
 *
 * Used to blunt password brute-force against /login and /signup. It is
 * intentionally dependency-free and lives in module memory, which means:
 *   - It is BEST-EFFORT on serverless/multi-instance hosts (each instance has
 *     its own counters). It still meaningfully slows a single attacker hitting
 *     a warm instance, and is solid on a single long-lived process.
 *   - For strong, cluster-wide limits, back this with a shared store (Redis,
 *     Postgres, Upstash) — the call sites only depend on the `rateLimit()`
 *     signature, so swapping the backend is local to this file.
 *
 * Fails OPEN (never throws): a limiter must never lock everyone out on a bug.
 */

interface Counter {
  count: number
  resetAt: number
}

const buckets = new Map<string, Counter>()

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterMs: number
}

/**
 * Record one hit for `key` and report whether it is within `limit` per
 * `windowMs`. Uses a fixed window: the first hit sets `resetAt`, and the
 * counter resets when that time elapses.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    sweep(now)
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 }
  }

  existing.count += 1
  if (existing.count > limit) {
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) }
  }
  return { ok: true, remaining: limit - existing.count, retryAfterMs: 0 }
}

/** Drop expired buckets opportunistically so the map can't grow unbounded. */
function sweep(now: number): void {
  if (buckets.size < 5000) return
  for (const [k, v] of buckets) {
    if (now >= v.resetAt) buckets.delete(k)
  }
}

/**
 * Best-effort client IP from standard proxy headers (set by Vercel and most
 * reverse proxies). Falls back to a constant so the limiter still applies (as a
 * single shared bucket) when no IP is available.
 */
export function clientIp(headerList: Headers): string {
  const xff = headerList.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return headerList.get('x-real-ip')?.trim() || 'unknown'
}
