import type { Config } from './config'

export type CheckStatus = 'approved' | 'denied' | 'unknown'

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
  })
  if (!res.ok) {
    throw new Error(`check failed: HTTP ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { status?: CheckStatus }
  return json.status ?? 'unknown'
}

/** Lightweight connectivity probe for `status`. */
export async function ping(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.apiUrl}/api/senders?channel=imessage`, {
      headers: { 'x-api-key': cfg.apiKey },
    })
    return res.ok
  } catch {
    return false
  }
}
