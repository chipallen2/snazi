import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface Config {
  apiUrl: string
  apiKey: string
}

export const CONFIG_DIR = path.join(os.homedir(), '.soup-nazi')
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
  return cfg
}
