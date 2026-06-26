/**
 * Short-lived, on-disk cache for sender approval STATUS (never message text).
 *
 * Why disk and not memory: the CLI runs on demand and exits, so an in-memory
 * cache would be empty on every invocation. A small JSON file in ~/.snazi lets
 * repeated `read`/`check`/`list-new` calls (and a long-running `serve`) reuse a
 * recent decision instead of hitting the API every time.
 *
 * What it caches: only DECIDED states (approved/denied), which reflect an
 * explicit human decision that rarely flips. 'unknown' is NEVER cached, so a
 * brand-new approval takes effect on the very next call.
 *
 * The trade-off (deliberate): a REVOCATION can take up to `ttl` to be seen by
 * the agent. That is the whole point of the cache — approvals are sticky, and a
 * few minutes of staleness on the rare "I just blocked them" case is acceptable.
 * Use `fresh: true` (CLI `--fresh`) or `snazi cache clear` to force a live check
 * the instant you revoke someone.
 *
 * Safe degradation: any cache read/write error falls back to a live server check.
 * The cache can only skip a round-trip — it never fabricates an approval.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Config } from './config'
import { checkSender, type CheckStatus } from './api'
import { normalizeAddress } from './address'

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CacheEntry {
  status: CheckStatus
  expiresAt: number
}
type CacheFile = Record<string, CacheEntry>

/** Cache file path. SNAZI_CACHE_FILE overrides it (used by tests). */
function cacheFilePath(): string {
  const override = process.env.SNAZI_CACHE_FILE
  if (override && override.trim() !== '') return override
  return path.join(os.homedir(), '.snazi', 'check-cache.json')
}

/**
 * Resolve the cache TTL in ms: env SNAZI_CHECK_CACHE_TTL_MS wins, then
 * config.checkCacheTtlMs, then a 5-minute default. 0 (or negative) disables
 * caching entirely (every check goes live).
 */
export function cacheTtlMs(cfg: Config): number {
  const env = process.env.SNAZI_CHECK_CACHE_TTL_MS
  if (env !== undefined && env !== '') {
    const n = Number(env)
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n))
  }
  if (typeof cfg.checkCacheTtlMs === 'number' && Number.isFinite(cfg.checkCacheTtlMs)) {
    return Math.max(0, Math.floor(cfg.checkCacheTtlMs))
  }
  return DEFAULT_TTL_MS
}

/** Cache key: normalized so "(555) 123-4567" and "+15551234567" share an entry. */
function cacheKey(channel: string, address: string): string {
  return `${channel}|${normalizeAddress(address)}`
}

function readCache(): CacheFile {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as CacheFile) : {}
  } catch {
    return {} // missing/corrupt/unreadable -> treat as empty
  }
}

function writeCache(data: CacheFile): void {
  try {
    const file = cacheFilePath()
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Atomic: write a temp file then rename so readers never see a partial file.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    // Best-effort: a write failure must never break the gate.
  }
}

/** Cached status if present AND unexpired, else undefined. */
export function getCachedStatus(
  channel: string,
  address: string
): CheckStatus | undefined {
  const entry = readCache()[cacheKey(channel, address)]
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) return undefined
  return entry.status
}

/** Store a status for `ttlMs`. Prunes expired entries. No-op when ttlMs <= 0. */
export function setCachedStatus(
  channel: string,
  address: string,
  status: CheckStatus,
  ttlMs: number
): void {
  if (ttlMs <= 0) return
  const data = readCache()
  const now = Date.now()
  for (const k of Object.keys(data)) {
    if (now >= data[k].expiresAt) delete data[k]
  }
  data[cacheKey(channel, address)] = { status, expiresAt: now + ttlMs }
  writeCache(data)
}

/** Wipe the whole cache (used by `snazi cache clear`). */
export function clearCache(): void {
  try {
    const file = cacheFilePath()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    // Nothing to clear / not removable -> ignore.
  }
}

/**
 * Approval check with the short-lived cache in front of the live server gate.
 *
 * Reads a cached decided status when fresh; otherwise checks the server and
 * caches approved/denied results. `unknown` is never cached. Pass `fresh: true`
 * to bypass the cache for this call (and refresh it from the server).
 */
export async function checkSenderCached(
  cfg: Config,
  channel: string,
  address: string,
  opts: { fresh?: boolean } = {}
): Promise<CheckStatus> {
  const ttl = cacheTtlMs(cfg)
  if (!opts.fresh && ttl > 0) {
    const hit = getCachedStatus(channel, address)
    if (hit) return hit
  }
  const status = await checkSender(cfg, channel, address)
  if (status === 'approved' || status === 'denied') {
    setCachedStatus(channel, address, status, ttl)
  }
  return status
}
