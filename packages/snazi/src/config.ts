import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface Config {
  apiUrl: string
  apiKey: string
  /** Admin/mutate key — required only for `approve` / `deny`. */
  adminKey?: string
  /** Configured channels (e.g. ["imessage"]). */
  channels?: string[]

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

/** Load and validate config.json. Exits with a helpful message if missing. */
export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      JSON.stringify({
        error: `Config not found at ${CONFIG_PATH}. Run install.sh and fill in apiUrl + apiKey.`,
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
