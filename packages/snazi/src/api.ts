import type { Config } from './config'

export type CheckStatus = 'approved' | 'denied' | 'unknown'
export type SenderStatus = 'approved' | 'denied'

/**
 * One sender row as returned by the web GET /api/senders list. This mirrors the
 * server-side `Sender` shape but is declared locally so the CLI package stays
 * decoupled from the web package. `label` is human-readable DISPLAY metadata
 * only — it never implies approval.
 */
export interface SenderRecord {
  channel_id: string
  sender_address: string
  label: string | null
  status: SenderStatus
}


// Force every request to bypass any HTTP/runtime cache. Typed loosely because
// some @types/node versions omit `cache` from RequestInit.
const NO_STORE = { cache: 'no-store' } as RequestInit

/**
 * Ask the server whether a sender is approved/denied/unknown.
 * This is the gate: callers MUST check before revealing any content.
 */
export async function checkSender(
  cfg: Config,
  channel: string,
  address: string
): Promise<CheckStatus> {
  const url = `${cfg.apiUrl}/api/senders/check?channel=${encodeURIComponent(
    channel
  )}&address=${encodeURIComponent(address)}`
  const res = await fetch(url, {
    headers: { 'x-api-key': cfg.apiKey },
    ...NO_STORE,
  })
  if (!res.ok) {
    throw new Error(`check failed: HTTP ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { status?: CheckStatus }
  return json.status ?? 'unknown'
}

/**
 * Upsert a sender to approved/denied. Requires the admin key.
 * Used by `snazi approve` and `snazi deny`.
 */
export async function setSender(
  cfg: Config,
  channel: string,
  address: string,
  status: SenderStatus,
  label?: string
): Promise<unknown> {
  if (!cfg.adminKey) {
    throw new Error(
      'adminKey not set in config. Add "adminKey" to ~/.snazi/config.json to approve/deny.'
    )
  }
  const res = await fetch(`${cfg.apiUrl}/api/senders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.adminKey },
    body: JSON.stringify({
      channel_id: channel,
      sender_address: address,
      status,
      label: label ?? null,
      decided_by: 'cli',
    }),
    ...NO_STORE,
  })
  if (!res.ok) {
    throw new Error(`${status} failed: HTTP ${res.status} ${await res.text()}`)
  }
  return res.json()
}

/**
 * Fetch the FULL sender list (address + label + status) for a channel using the
 * READ key. Used by `snazi serve` to attach `label` to list-new/check results
 * and to power /resolve. Reveals only the same address+label+status surface the
 * dashboard read key already exposes — never message content.
 */
export async function listSenders(
  cfg: Config,
  channel: string
): Promise<SenderRecord[]> {
  const url = `${cfg.apiUrl}/api/senders?channel=${encodeURIComponent(channel)}`
  const res = await fetch(url, {
    headers: { 'x-api-key': cfg.apiKey },
    ...NO_STORE,
  })
  if (!res.ok) {
    throw new Error(`list senders failed: HTTP ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { senders?: SenderRecord[] }
  return Array.isArray(json.senders) ? json.senders : []
}

/**
 * Set (overwrite) a sender's display label using the READ key.
 *
 * This calls the web PATCH /api/senders/label endpoint, which performs an
 * UPDATE only — it can NEVER insert a new row or change `status`. It is the
 * single non-privileged write the read path can make: a label is display
 * metadata and cannot open the gate. If the sender is not already on the list,
 * the web endpoint returns 404 and this throws.
 */
export async function setLabel(
  cfg: Config,
  channel: string,
  address: string,
  label: string
): Promise<unknown> {
  const res = await fetch(`${cfg.apiUrl}/api/senders/label`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
    body: JSON.stringify({
      channel_id: channel,
      sender_address: address,
      label,
    }),
    ...NO_STORE,
  })
  if (!res.ok) {
    throw new Error(`label failed: HTTP ${res.status} ${await res.text()}`)
  }
  return res.json()
}

/** Lightweight connectivity probe for `status`. */
export async function ping(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.apiUrl}/api/senders?channel=imessage`, {
      headers: { 'x-api-key': cfg.apiKey },
      ...NO_STORE,
    })
    return res.ok
  } catch {
    return false
  }
}
