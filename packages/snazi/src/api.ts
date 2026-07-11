import type { Config } from './config'
import { normalizeAddress } from './address'

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
 * Fetch the full sender list once and build an address→label map.
 * Best-effort: on failure returns an empty map so labels show as null rather
 * than breaking the (security-critical) status path.
 */
export async function buildLabelMap(
  cfg: Config,
  channel: string
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  try {
    const senders = await listSenders(cfg, channel)
    for (const s of senders) {
      map.set(normalizeAddress(s.sender_address), s.label ?? null)
    }
  } catch {
    // Swallow: labels are non-critical display metadata.
  }
  return map
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
): Promise<{ sender: SenderRecord }> {
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
  return res.json() as Promise<{ sender: SenderRecord }>
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

/**
 * Auto-approve a recipient after the agent sends them a message.
 * Calls POST /api/senders/auto-approve on the web tier. The web tier checks
 * the owner's `auto_approve_on_send` flag and only upserts if it is TRUE.
 * This is fire-and-forget: failures are swallowed so a transient web-tier
 * issue never blocks an outbound send that already succeeded.
 */
export async function autoApproveAfterSend(
  cfg: Config,
  channel: string,
  recipient: string
): Promise<void> {
  const apiUrl = (cfg.apiUrl ?? '').replace(/\/+$/, '')
  const apiKey = cfg.apiKey ?? ''
  if (!apiUrl || !apiKey) return
  try {
    await fetch(`${apiUrl}/api/senders/auto-approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ channel, address: recipient }),
      ...NO_STORE,
    })
  } catch {
    // Fire-and-forget: a web-tier error must not affect the send result.
  }
}
