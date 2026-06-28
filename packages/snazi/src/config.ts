import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Per-channel credentials. LOCAL ONLY — these never leave this machine and are
 * never sent to the snazi server (which stores no secrets). Which fields apply
 * depends on the channel type:
 *   - gmail/outlook: clientId + clientSecret + refreshToken (OAuth2). outlook
 *     also takes an optional tenantId (default 'common').
 *   - imessage: none (it reads the local Messages database).
 */
export interface ChannelAuth {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  /**
   * Microsoft Entra tenant id (outlook only). For a single-tenant app this MUST
   * be the directory's tenant id (a GUID) or a verified domain — NOT 'common'.
   * Default 'common' (works only for multi-tenant apps).
   */
  tenantId?: string
  /**
   * Optional space-delimited OAuth scopes to request on token refresh. Leave
   * unset to INHERIT whatever the refresh token was originally granted — the
   * most compatible choice (e.g. tokens minted by n8n). Only set this if you
   * need to narrow the scopes.
   */
  scope?: string
  /** Mailbox address (optional; used as the From identity when sending). */
  user?: string
}

/**
 * A configured channel INSTANCE. `id` is the per-account slug used as
 * `--channel` and in every API call (it must match the channel's slug in the
 * dashboard). `type` selects the local adapter (imessage | gmail | outlook).
 */
export interface ChannelConfig {
  id: string
  type: string
  name?: string
  auth?: ChannelAuth
}

export interface Config {
  apiUrl: string
  /**
   * Per-account READ token (from the dashboard Account page; stored as
   * `read_token` in the database). Serialized as `apiKey` in config.json for
   * backward compatibility. Authenticates check/list/read/label and minting
   * /decide links. READ-ONLY: it can never approve/deny a sender.
   */
  apiKey: string
  /**
   * Configured channels. Each is a named INSTANCE of a type. The legacy form —
   * an array of plain type strings (e.g. ["imessage"]) — is still accepted and
   * normalized by normalizeChannels(); prefer the object form for new configs:
   *   [{ "id": "gmail-work", "type": "gmail", "name": "Work", "auth": {...} }]
   */
  channels?: Array<string | ChannelConfig>
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

/**
 * Load config for the AGENT MACHINE (the `remote-*` commands).
 *
 * Unlike loadConfig(), this does NOT require apiUrl/apiKey — an agent machine
 * holds no channel credentials and needs only to know which messages machine to
 * call (`remoteUrl`). It MAY also carry a read-only READ token (apiUrl/apiKey)
 * so the agent can mint one-tap `/decide` approve links, but that's optional.
 * The bearer token (`remoteToken`) is validated per-request by client.ts.
 */
export function loadRemoteConfig(): Config {
  const cfg = readConfigIfPresent()
  if (!cfg) {
    console.error(
      JSON.stringify({
        error: `Config not found at ${CONFIG_PATH}. Run 'snazi init-agent' to set up this agent machine.`,
      })
    )
    process.exit(2)
  }
  if (!cfg.remoteUrl) {
    console.error(
      JSON.stringify({
        error:
          "This machine isn't configured to reach a messages machine (no remoteUrl). " +
          "Run 'snazi init-agent' here to point it at your messages machine.",
      })
    )
    process.exit(2)
  }
  return cfg
}

/**
 * Normalize `cfg.channels` (which may mix legacy type-strings and instance
 * objects) into a clean list of ChannelConfig instances. A bare string `s`
 * becomes `{ id: s, type: s, name: s }` so old configs ("imessage") keep
 * working. Entries without an id are dropped.
 */
export function normalizeChannels(
  channels: Array<string | ChannelConfig> | undefined
): ChannelConfig[] {
  if (!Array.isArray(channels)) return []
  const out: ChannelConfig[] = []
  for (const c of channels) {
    if (typeof c === 'string') {
      const id = c.trim()
      if (id) out.push({ id, type: id, name: id })
    } else if (c && typeof c === 'object' && typeof c.id === 'string' && c.id.trim()) {
      out.push({
        id: c.id.trim(),
        type: (c.type ?? c.id).trim(),
        name: c.name ?? c.id,
        auth: c.auth,
      })
    }
  }
  return out
}

/** Find a configured channel instance by its id (slug), or undefined. */
export function findChannel(
  cfg: Pick<Config, 'channels'>,
  id: string
): ChannelConfig | undefined {
  return normalizeChannels(cfg.channels).find((c) => c.id === id)
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
