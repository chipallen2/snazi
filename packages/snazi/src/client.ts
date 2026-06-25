/**
 * snazi remote-* — thin client for the trusted agent side.
 *
 * Calls a remote `snazi serve` (over the tailnet) instead of reading a local
 * chat.db. Same gate applies on the server: `remote-read` only returns text if
 * the sender is approved on the server list.
 *
 * Config (~/.snazi/config.json):
 *   "remoteUrl":   "http://100.x.y.z:8787"
 *   "remoteToken": "<matches the serve host's serveToken>"
 */
import type { Config } from './config'

const NO_STORE = { cache: 'no-store' } as RequestInit

function remoteBase(cfg: Config): { url: string; token: string } {
  if (!cfg.remoteUrl) {
    throw new Error(
      'remoteUrl not set in ~/.snazi/config.json. Add the remote serve base URL ' +
        '(e.g. "http://100.84.4.92:8787").'
    )
  }
  if (!cfg.remoteToken) {
    throw new Error(
      'remoteToken not set in ~/.snazi/config.json. Add the bearer token that ' +
        'matches the remote host\'s serveToken.'
    )
  }
  return { url: cfg.remoteUrl.replace(/\/+$/, ''), token: cfg.remoteToken }
}

async function getJson(
  base: string,
  token: string,
  pathAndQuery: string
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
    ...NO_STORE,
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = { error: `Non-JSON response: HTTP ${res.status}` }
  }
  return { status: res.status, json }
}

async function postJson(
  base: string,
  token: string,
  path: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...NO_STORE,
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = { error: `Non-JSON response: HTTP ${res.status}` }
  }
  return { status: res.status, json }
}

/** Remote equivalent of `snazi list-new`. */
export async function remoteListNew(
  cfg: Config,
  channel: string,
  since: number
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/list-new?channel=${encodeURIComponent(channel)}&since=${since}`
  return getJson(url, token, q)
}

/** Remote equivalent of `snazi read` (gate enforced server-side). */
export async function remoteRead(
  cfg: Config,
  sender: string,
  channel: string,
  since: number
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/read?sender=${encodeURIComponent(sender)}&channel=${encodeURIComponent(
    channel
  )}&since=${since}`
  return getJson(url, token, q)
}

/**
 * Resolve a name to sender address(es) via the remote serve /resolve endpoint.
 * Empty/omitted name returns the whole address book (every labelled sender).
 * Returns address+label+status only — never message text.
 */
export async function remoteResolve(
  cfg: Config,
  name: string,
  channel: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/resolve?name=${encodeURIComponent(name)}&channel=${encodeURIComponent(
    channel
  )}`
  return getJson(url, token, q)
}

/**
 * Set a sender's display label via the remote serve POST /label endpoint.
 * The serve host performs an UPDATE-only write — it cannot create a row or
 * change approval status, so this can never open the gate.
 */
export async function remoteLabel(
  cfg: Config,
  sender: string,
  channel: string,
  name: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  return postJson(url, token, '/label', { sender, channel, name })
}

/** Remote equivalent of `snazi check`. */
export async function remoteCheck(
  cfg: Config,
  sender: string,
  channel: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/check?sender=${encodeURIComponent(sender)}&channel=${encodeURIComponent(
    channel
  )}`
  return getJson(url, token, q)
}

/** Connectivity probe against a remote serve `/health`. */
export async function remoteHealth(
  cfg: Config
): Promise<{ status: number; json: unknown }> {
  if (!cfg.remoteUrl) {
    throw new Error('remoteUrl not set in ~/.snazi/config.json.')
  }
  const base = cfg.remoteUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/health`, { ...NO_STORE })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = { error: `Non-JSON response: HTTP ${res.status}` }
  }
  return { status: res.status, json }
}
