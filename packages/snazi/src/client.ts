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
        '(e.g. "http://100.x.y.z:8787").'
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

/**
 * Remote equivalent of `snazi send` (never gated). `opts.html` upgrades email
 * channels to an HTML send; `opts.subject` sets the subject. Both optional and
 * omitted from the wire body when absent, so the plain-text path is unchanged.
 */
export async function remoteSend(
  cfg: Config,
  recipient: string,
  channel: string,
  text: string,
  opts?: {
    subject?: string
    html?: string
    from?: string
    replyToMessageId?: string
    replyAll?: boolean
  }
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const body: Record<string, unknown> = { recipient, channel, text }
  if (opts?.subject) body.subject = opts.subject
  if (opts?.html) body.html = opts.html
  if (opts?.from) body.from = opts.from
  if (opts?.replyToMessageId) body.replyToMessageId = opts.replyToMessageId
  if (opts?.replyAll) body.replyAll = true
  return postJson(url, token, '/send', body)
}

/**
 * Perform a message action (archive/delete/markRead/markUnread) via the remote
 * serve POST /action endpoint. NEVER gated — actions don't require approval.
 * Target with either `sender` (all matching messages in the window) or
 * `messageId` (one message).
 */
export async function remoteAction(
  cfg: Config,
  params: { sender?: string; messageId?: string; channel: string; action: string; sinceMinutes?: number }
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const body: Record<string, unknown> = {
    channel: params.channel,
    action: params.action,
  }
  if (params.sender) body.sender = params.sender
  if (params.messageId) body.messageId = params.messageId
  if (params.sinceMinutes != null) body.sinceMinutes = params.sinceMinutes
  return postJson(url, token, '/action', body)
}

/** Send a JSON body with an arbitrary method (PATCH), parse the JSON reply. */
async function sendJson(
  base: string,
  token: string,
  method: string,
  path: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
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

/** DELETE a path (no body), parse the JSON reply. */
async function deleteJson(
  base: string,
  token: string,
  path: string
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
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

/** A provider-neutral filter/rule spec passed to the serve host. */
export interface RemoteFilterSpec {
  from?: string
  to?: string
  subject?: string
  query?: string
  action?: string
  labelId?: string
  forwardTo?: string
  folderId?: string
  name?: string
  criteria?: Record<string, unknown>
  actions?: Record<string, unknown>
}

/** Create a Gmail filter / Outlook rule via the remote serve POST /filter/create. */
export async function remoteFilterCreate(
  cfg: Config,
  channel: string,
  spec: RemoteFilterSpec
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  return postJson(url, token, '/filter/create', { channel, ...spec })
}

/** List filters/rules via the remote serve GET /filter/list. */
export async function remoteFilterList(
  cfg: Config,
  channel: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  return getJson(url, token, `/filter/list?channel=${encodeURIComponent(channel)}`)
}

/** Get one filter/rule via the remote serve GET /filter/get. */
export async function remoteFilterGet(
  cfg: Config,
  channel: string,
  id: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/filter/get?channel=${encodeURIComponent(channel)}&id=${encodeURIComponent(id)}`
  return getJson(url, token, q)
}

/** Update a rule (Outlook only) via the remote serve PATCH /filter/update. */
export async function remoteFilterUpdate(
  cfg: Config,
  channel: string,
  id: string,
  spec: RemoteFilterSpec
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/filter/update?channel=${encodeURIComponent(channel)}&id=${encodeURIComponent(id)}`
  return sendJson(url, token, 'PATCH', q, spec)
}

/** Delete a filter/rule via the remote serve DELETE /filter/delete. */
export async function remoteFilterDelete(
  cfg: Config,
  channel: string,
  id: string
): Promise<{ status: number; json: unknown }> {
  const { url, token } = remoteBase(cfg)
  const q = `/filter/delete?channel=${encodeURIComponent(channel)}&id=${encodeURIComponent(id)}`
  return deleteJson(url, token, q)
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
