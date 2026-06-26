import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface Config {
  apiUrl: string
  /**
   * Per-account READ token (from the dashboard Account page; stored as
   * `read_token` in the database). Serialized as `apiKey` in config.json for
   * backward compatibility. Authenticates check/list/read/label and minting
   * /decide links. READ-ONLY: it can never approve/deny a sender.
   */
  apiKey: string
  /** Configured channels (e.g. ["imessage"]). */
  channels?: string[]
  /**
   * TTL (ms) for the on-disk approval-status cache used by check/read/list-new.
   * Decided states (approved/denied) are cached this long to avoid re-checking
   * the server on every call; 'unknown' is never cached. Default 300000 (5 min).
   * Set 0 to disable. Env SNAZI_CHECK_CACHE_TTL_MS overrides this.
   */
  checkCacheTtlMs?: number

  // ---- serve mode (HTTP gate for a remote trusted agent over a tailnet) ----
  /** Bearer token required by every protected `snazi serve` endpoint. */
  serveToken?: string
  /**
   * IP to bind `snazi serve` to. Default: the Tailscale interface IP
   * (100.64.0.0/10) if present, else 127.0.0.1. NEVER 0.0.0.0.
   */
  serveBind?: string
  /** Port for `snazi serve`. Default 8787. */
  servePort?: number

  // ---- remote client (the trusted agent side calling a remote serve) ----
  /** Base URL of a remote `snazi serve` (e.g. http://100.x.y.z:8787). */
  remoteUrl?: string
  /** Bearer token for the remote serve (matches its serveToken). */
  remoteToken?: string
}

export const CONFIG_DIR = path.join(os.homedir(), '.snazi')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/** Default deployment used by `snazi init` when none is supplied. */
export const DEFAULT_API_URL = 'https://snazi.dev'

/**
 * Read config.json if it exists, WITHOUT exiting on missing/invalid input.
 * Returns the parsed config (apiUrl trailing slash stripped) or null. Used by
 * `snazi init` and `snazi doctor`, which must run before a valid config exists.
 */
export function readConfigIfPresent(): Config | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config
    if (cfg && typeof cfg === 'object') {
      if (typeof cfg.apiUrl === 'string') cfg.apiUrl = cfg.apiUrl.replace(/\/+$/, '')
      return cfg
    }
    return null
  } catch {
    return null
  }
}

/** Load and validate config.json. Exits with a helpful message if missing. */
export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      JSON.stringify({
        error: `Config not found at ${CONFIG_PATH}. Run 'snazi init' to create it.`,
      })
    )
    process.exit(2)
  }
  let raw: string
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch (e) {
    console.error(JSON.stringify({ error: `Cannot read config: ${String(e)}` }))
    process.exit(2)
  }
  let cfg: Config
  try {
    cfg = JSON.parse(raw)
  } catch {
    console.error(JSON.stringify({ error: 'config.json is not valid JSON.' }))
    process.exit(2)
  }
  if (!cfg.apiUrl || !cfg.apiKey) {
    console.error(
      JSON.stringify({ error: 'config.json must include apiUrl and apiKey.' })
    )
    process.exit(2)
  }
  // Normalize: strip trailing slash from apiUrl.
  cfg.apiUrl = cfg.apiUrl.replace(/\/+$/, '')
  if (!Array.isArray(cfg.channels)) cfg.channels = ['imessage']
  return cfg
}

/** Persist config back to disk (preserving 0600 perms). */
export function saveConfig(cfg: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', {
    mode: 0o600,
  })
}
