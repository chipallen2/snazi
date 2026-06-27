/**
 * `snazi doctor` — one command that tells a new user exactly what's wrong.
 *
 * Checks, in order:
 *   - Node version (>= 18, required for global fetch)
 *   - Config present + valid (apiUrl + token)
 *   - Server reachable with the configured token
 *   - For each configured channel: is there a local adapter, and can it read on
 *     THIS machine right now (platform + Full Disk Access for iMessage)?
 *
 * Output is JSON (like the rest of the CLI). `problems` are hard failures that
 * set a non-zero exit code; `warnings` (server unreachable, a channel that only
 * works remotely on this OS) are surfaced but do not fail, because remote-only
 * use (e.g. a Windows box driving a Mac `snazi serve`) is legitimate.
 */
import { CONFIG_PATH, readConfigIfPresent, normalizeChannels } from './config'
import { ping } from './api'
import { getAdapter, listAdapters } from './channels'

const MIN_NODE_MAJOR = 18

export async function runDoctor(): Promise<{ code: number; report: unknown }> {
  const problems: string[] = []
  const warnings: string[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
  if (!nodeOk) {
    problems.push(
      `Node ${process.versions.node} is too old; snazi needs Node ${MIN_NODE_MAJOR}+ (global fetch).`
    )
  }

  const cfg = readConfigIfPresent()
  const configPresent = Boolean(cfg)
  const configValid = Boolean(cfg && cfg.apiUrl && cfg.apiKey)
  if (!configPresent) {
    problems.push(`No config at ${CONFIG_PATH}. Run 'snazi init'.`)
  } else if (!configValid) {
    problems.push(
      `Config at ${CONFIG_PATH} is missing apiUrl or apiKey. Run 'snazi init'.`
    )
  }

  let serverReachable: boolean | null = null
  if (configValid && cfg) {
    serverReachable = await ping(cfg)
    if (!serverReachable) {
      warnings.push(
        `Cannot reach ${cfg.apiUrl} with the configured token. Check the URL, token, and network.`
      )
    }
  }

  const instances = normalizeChannels(cfg?.channels)
  const configuredChannels =
    instances.length > 0
      ? instances
      : configValid
        ? [{ id: 'imessage', type: 'imessage', name: 'iMessage' }]
        : []

  const channels = configuredChannels.map((inst) => {
    const adapter = getAdapter(inst.type)
    const ctx = {
      id: inst.id,
      type: inst.type,
      name: inst.name ?? inst.id,
      auth: inst.auth ?? {},
    }
    if (!adapter) {
      warnings.push(
        `Channel '${inst.id}' (type '${inst.type}') has no local adapter on this build; only remote-* (against a host that supports it) will work here.`
      )
      return {
        id: inst.id,
        type: inst.type,
        known: false,
        available: false,
        reason: 'no local adapter on this build',
        detail: null as string | null,
      }
    }
    const av = adapter.availability(ctx)
    const sendAv = adapter.sendAvailability?.(ctx)
    if (!av.available) {
      warnings.push(`Channel '${inst.id}' (${inst.type}) is not readable locally: ${av.reason}`)
    }
    if (adapter.sendMessage && sendAv && !sendAv.available) {
      warnings.push(`Channel '${inst.id}' (${inst.type}) cannot send locally: ${sendAv.reason}`)
    }
    return {
      id: inst.id,
      type: inst.type,
      known: true,
      available: av.available,
      reason: av.reason ?? null,
      detail: av.detail ?? null,
      send_available: sendAv?.available ?? null,
      send_reason: sendAv?.reason ?? null,
    }
  })

  const report = {
    ok: problems.length === 0,
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    node_ok: nodeOk,
    config: {
      path: CONFIG_PATH,
      present: configPresent,
      valid: configValid,
      apiUrl: cfg?.apiUrl ?? null,
      token_present: Boolean(cfg?.apiKey),
    },
    server_reachable: serverReachable,
    channels,
    adapters: listAdapters().map((a) => ({
      id: a.id,
      display_name: a.displayName,
      platforms: a.platforms,
    })),
    problems,
    warnings,
  }

  return { code: problems.length === 0 ? 0 : 1, report }
}
