/**
 * Channel adapter registry.
 *
 * A channel adapter knows how to read "who messaged" and "what they said" for
 * one medium TYPE (iMessage, Gmail, Outlook) on the LOCAL machine. The CLI and
 * `snazi serve` go through this registry instead of touching any single
 * channel's storage directly, so:
 *   - adding a channel TYPE = writing an adapter + registering it here, and
 *   - a channel that can't run on this OS reports itself unavailable cleanly
 *     (e.g. iMessage on Windows) rather than crashing.
 *
 * Channels are configured as named INSTANCES (see config.ChannelConfig): a user
 * can have several of the same type ("Personal" + "Work" gmail). The `--channel`
 * value is an instance id (slug). resolveReadable/SendableAdapter map that id to
 * its instance (for the type + local credentials), then to the type's adapter,
 * and hand the adapter a ChannelContext so it acts for the right mailbox.
 *
 * The approval gate (api.ts) and the server list are channel-agnostic and live
 * OUTSIDE this registry; adapters only provide the local message SOURCE.
 *
 * To add a channel TYPE:
 *   1. Create src/channels/<type>.ts exporting a ChannelAdapter.
 *   2. Add it to ADAPTERS below.
 *   3. Add a matching row to the server's sna_channel_types registry.
 */
import type { ChannelAdapter, ChannelContext } from './types'
import type { Config } from '../config'
import { normalizeChannels } from '../config'
import { imessageAdapter } from './imessage'
import { gmailAdapter } from './gmail'
import { outlookAdapter } from './outlook'

const ADAPTERS: ReadonlyMap<string, ChannelAdapter> = new Map(
  [imessageAdapter, gmailAdapter, outlookAdapter].map((a) => [a.id, a] as const)
)

/** Look up a registered adapter by channel TYPE id, or undefined. */
export function getAdapter(id: string): ChannelAdapter | undefined {
  return ADAPTERS.get(id)
}

/** Every registered adapter (in registration order). */
export function listAdapters(): ChannelAdapter[] {
  return [...ADAPTERS.values()]
}

export interface ResolvedAdapter {
  adapter?: ChannelAdapter
  /** Context for the resolved instance (type + local creds). */
  ctx?: ChannelContext
  error?: string
}

/**
 * Build a ChannelContext for a `--channel` value. If a config is supplied and
 * has a matching instance, its type + name + credentials are used. Otherwise the
 * value is treated as a bare type id (so `imessage` works with no instance
 * configured, and unknown ids still resolve to a clear "unknown channel" error).
 */
function buildContext(channel: string, cfg?: Pick<Config, 'channels'>): ChannelContext {
  const instance = cfg
    ? normalizeChannels(cfg.channels).find((c) => c.id === channel)
    : undefined
  const type = instance?.type ?? channel
  return {
    id: channel,
    type,
    name: instance?.name ?? channel,
    auth: instance?.auth ?? {},
  }
}

function unknownChannelError(channel: string): string {
  const known = listAdapters()
    .map((a) => a.id)
    .join(', ')
  return `Unknown channel '${channel}'. Known channels: ${known || '(none)'}.`
}

/**
 * Resolve a channel id to an adapter that can actually READ on this host.
 * Never throws: returns a helpful `error` string when the channel is unknown
 * or unavailable on this platform, so callers can surface it as JSON.
 */
export function resolveReadableAdapter(
  channel: string,
  cfg?: Pick<Config, 'channels'>
): ResolvedAdapter {
  const ctx = buildContext(channel, cfg)
  const adapter = getAdapter(ctx.type)
  if (!adapter) {
    return { error: unknownChannelError(channel) }
  }
  const availability = adapter.availability(ctx)
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}` : ''
    return {
      error: `Channel '${channel}' is not available on this machine: ${
        availability.reason ?? 'unavailable'
      }.${detail}`,
    }
  }
  return { adapter, ctx }
}

/**
 * Resolve a channel id to an adapter that can SEND on this host.
 * Never throws. Sending is never gated by the approval list.
 */
export function resolveSendableAdapter(
  channel: string,
  cfg?: Pick<Config, 'channels'>
): ResolvedAdapter {
  const ctx = buildContext(channel, cfg)
  const adapter = getAdapter(ctx.type)
  if (!adapter) {
    return { error: unknownChannelError(channel) }
  }
  if (!adapter.sendMessage) {
    return { error: `Channel '${channel}' does not support sending.` }
  }
  const availability = adapter.sendAvailability?.(ctx) ?? { available: true }
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}` : ''
    return {
      error: `Channel '${channel}' cannot send on this machine: ${
        availability.reason ?? 'unavailable'
      }.${detail}`,
    }
  }
  return { adapter, ctx }
}

export type {
  ChannelAdapter,
  ChannelAvailability,
  ChannelContext,
  SenderSummary,
  MessageRow,
} from './types'
