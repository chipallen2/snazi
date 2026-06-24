import type { Config } from './config'

export type CheckStatus = 'approved' | 'denied' | 'unknown'
export type SenderStatus = 'approved' | 'denied'

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
