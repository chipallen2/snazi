/**
 * Channel adapter registry.
 *
 * A channel adapter knows how to read "who messaged" and "what they said" for
 * one medium (iMessage today; Gmail/Outlook/etc. later) on the LOCAL machine.
 * The CLI and `snazi serve` go through this registry instead of touching any
 * single channel's storage directly, so:
 *   - adding a channel = writing an adapter + registering it here, and
 *   - a channel that can't run on this OS reports itself unavailable cleanly
 *     (e.g. iMessage on Windows) rather than crashing.
 *
 * The approval gate (api.ts) and the server list are channel-agnostic and live
 * OUTSIDE this registry; adapters only provide the local message SOURCE.
 *
 * To add a channel:
 *   1. Create src/channels/<id>.ts exporting a ChannelAdapter.
 *   2. Add it to ADAPTERS below.
 *   3. Add a matching row to the server's sna_channels registry.
 */
import type { ChannelAdapter } from './types'
import { imessageAdapter } from './imessage'

const ADAPTERS: ReadonlyMap<string, ChannelAdapter> = new Map(
  [imessageAdapter].map((a) => [a.id, a] as const)
)

/** Look up a registered adapter by channel id, or undefined. */
export function getAdapter(id: string): ChannelAdapter | undefined {
  return ADAPTERS.get(id)
}

/** Every registered adapter (in registration order). */
export function listAdapters(): ChannelAdapter[] {
  return [...ADAPTERS.values()]
}

export interface ResolvedAdapter {
  adapter?: ChannelAdapter
  error?: string
}

/**
 * Resolve a channel id to an adapter that can actually READ on this host.
 * Never throws: returns a helpful `error` string when the channel is unknown
 * or unavailable on this platform, so callers can surface it as JSON.
 */
export function resolveReadableAdapter(channel: string): ResolvedAdapter {
  const adapter = getAdapter(channel)
  if (!adapter) {
    const known = listAdapters()
      .map((a) => a.id)
      .join(', ')
    return {
      error: `Unknown channel '${channel}'. Known channels: ${known || '(none)'}.`,
    }
  }
  const availability = adapter.availability()
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}` : ''
    return {
      error: `Channel '${channel}' is not available on this machine: ${
        availability.reason ?? 'unavailable'
      }.${detail}`,
    }
  }
  return { adapter }
}

export type { ChannelAdapter, ChannelAvailability, SenderSummary, MessageRow } from './types'
