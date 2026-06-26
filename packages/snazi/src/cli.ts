#!/usr/bin/env node
/**
 * snazi — on-demand message gate.
 *
 *   "No messages for you."
 *
 * This CLI is the LOCAL gate. It runs on demand (NOT a daemon).
 * - init     : create/update ~/.snazi/config.json (interactive or via flags).
 * - doctor   : diagnose Node, config, connectivity, and per-channel access.
 * - list-new : reveals WHO sent recent messages + their approval status. Never WHAT.
 * - read     : reveals message TEXT for ONE sender, but ONLY if approved by the server.
 * - send     : sends a message to ANY recipient (never gated).
 * - check    : prints a single sender's approval status.
 * - channels : list/add configured channels + show adapter availability here.
 * - status   : prints config + platform + server connectivity.
 *
 * Local message sources are pluggable CHANNEL ADAPTERS (see src/channels). The
 * CLI itself is cross-platform; a channel that can't run on this OS (e.g.
 * iMessage off macOS) reports itself unavailable instead of crashing.
 *
 * Approvals are READ-ONLY here: a sender is approved/denied in the web
 * dashboard or via a signed /decide link, never from this CLI. The token in
 * ~/.snazi/config.json is a per-account READ token that cannot mutate the list.
 *
 * The server stores no messages. This CLI stores no message content; it keeps
 * only a short-lived approval-STATUS cache (~/.snazi/check-cache.json) so it
 * needn't re-check every call. Content is read live from the local Messages
 * database and printed only when the gate opens.
 */
import { loadConfig, saveConfig, readConfigIfPresent, CONFIG_PATH } from './config'
import { normalizeAddress, validateRecipientAddress } from './address'
import { buildLabelMap, ping, type CheckStatus } from './api'
import { checkSenderCached, clearCache } from './cache'
import { resolveReadableAdapter, resolveSendableAdapter, listAdapters, getAdapter } from './channels'
import { buildContactIndex } from './contacts'
import { startServer } from './server'
import {
  remoteListNew,
  remoteRead,
  remoteCheck,
  remoteHealth,
  remoteResolve,
  remoteLabel,
  remoteSend,
} from './client'
import { installDaemon, LABEL } from './daemon'
import { runInit } from './init'
import { runDoctor } from './doctor'

const DEFAULT_CHANNEL = 'imessage'

function parseSince(args: string[], def = 60): number {
  const i = args.indexOf('--since')
  if (i !== -1 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return def
}

/** Read a named --flag's value. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) {
    return args[i + 1]
  }
  return undefined
}

/** True if a boolean --flag is present. */
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parsePort(args: string[]): number | undefined {
  const v = flag(args, '--port')
  if (v == null) return undefined
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) return undefined
  return n
}

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2))
}

async function cmdListNew(args: string[]): Promise<number> {
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const fresh = hasFlag(args, '--fresh')
  const cfg = loadConfig()

  const { adapter, error } = resolveReadableAdapter(channel)
  if (!adapter) {
    out({ error })
    return 1
  }
  const senders = adapter.listInboundSenders(since)
  const labels = await buildLabelMap(cfg, channel)
  // Local macOS Contacts enrichment (display-only; best-effort, empty on fail).
  const contacts = buildContactIndex()

  const results = []
  for (const s of senders) {
    let status: CheckStatus = 'unknown'
    let checkError: string | undefined
    try {
      status = await checkSenderCached(cfg, channel, s.sender, { fresh })
    } catch (e) {
      checkError = String(e instanceof Error ? e.message : e)
    }
    const entry: Record<string, unknown> = {
      sender: s.sender,
      message_count: s.message_count,
      latest_at: s.latest_at,
      status,
      // `label` = snazi.dev account name; `contact_name` = local Contacts name.
      // Both kept as SEPARATE fields; contact_name never affects the gate.
      label: labels.get(normalizeAddress(s.sender)) ?? null,
      contact_name: contacts.get(s.sender),
    }
    if (checkError) entry.error = checkError
    results.push(entry)
  }
  out(results)
  return 0
}

async function cmdRead(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = normalizeAddress(positionals[0])
  if (!target) {
    out({ error: 'Usage: snazi read <sender> [--channel <id>] [--since <minutes>]' })
    return 2
  }
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const fresh = hasFlag(args, '--fresh')
  const cfg = loadConfig()

  // Resolve the local source first so an unsupported channel/platform fails
  // with a clear message (and never touches the network or any message text).
  const { adapter, error } = resolveReadableAdapter(channel)
  if (!adapter) {
    out({ error })
    return 1
  }

  // GATE: check approval BEFORE touching any message text.
  let status: string
  try {
    status = await checkSenderCached(cfg, channel, target, { fresh })
  } catch (e) {
    out({ error: `Approval check failed: ${String(e)}` })
    return 1
  }

  if (status !== 'approved') {
    out({ error: 'Sender not approved. No messages for you.', status })
    return 1
  }

  const messages = adapter.readMessagesFrom(target, since)
  out({ sender: target, status, since_minutes: since, messages })
  return 0
}

async function cmdCheck(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = normalizeAddress(positionals[0])
  if (!target) {
    out({ error: 'Usage: snazi check <sender> --channel <id>' })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const fresh = hasFlag(args, '--fresh')
  const cfg = loadConfig()
  try {
    const status = await checkSenderCached(cfg, channel, target, { fresh })
    const labels = await buildLabelMap(cfg, channel)
    const label = labels.get(target) ?? null
    // Display-only Contacts name; separate field, never gates reading.
    const contact_name = buildContactIndex().get(target)
    out({ channel, sender: target, status, label, contact_name })
    return 0
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdSend(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const rawRecipient = positionals[0]
  const text = flag(args, '--text')
  if (!rawRecipient || text == null) {
    out({
      error: 'Usage: snazi send <recipient> --text <message> [--channel <id>]',
    })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL

  let target: string
  try {
    target = validateRecipientAddress(rawRecipient)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 2
  }

  // Sending is NEVER gated — the soup nazi only blocks reading.
  const { adapter, error } = resolveSendableAdapter(channel)
  if (!adapter?.sendMessage) {
    out({ error })
    return 1
  }
  try {
    adapter.sendMessage(target, text)
    out({ ok: true, channel, recipient: target })
    return 0
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdCache(args: string[]): Promise<number> {
  const sub = args[0]
  if (sub === 'clear') {
    clearCache()
    out({ ok: true, cleared: true })
    return 0
  }
  out({ error: `Unknown cache subcommand: ${sub ?? '(none)'}. Use 'clear'.` })
  return 2
}

async function cmdChannels(args: string[]): Promise<number> {
  const sub = args[0]

  if (sub === 'list' || sub === undefined) {
    // Works even before `snazi init` (read config leniently, don't exit).
    const cfg = readConfigIfPresent()
    const adapters = listAdapters().map((a) => {
      const av = a.availability()
      return {
        id: a.id,
        display_name: a.displayName,
        platforms: a.platforms,
        available_here: av.available,
        reason: av.reason ?? null,
      }
    })
    out({ configured: cfg?.channels ?? [], adapters })
    return 0
  }

  if (sub === 'add') {
    const channel = args[1]
    if (!channel) {
      out({ error: 'Usage: snazi channels add <channel>' })
      return 2
    }
    const cfg = loadConfig()
    const channels = new Set(cfg.channels ?? [])
    channels.add(channel)
    cfg.channels = [...channels]
    saveConfig(cfg)
    const known = getAdapter(channel)
    out({
      ok: true,
      channels: cfg.channels,
      note: known
        ? undefined
        : `'${channel}' has no local adapter yet; it can still be used with remote-* against a host that supports it.`,
    })
    return 0
  }

  out({ error: `Unknown channels subcommand: ${sub}. Use 'list' or 'add'.` })
  return 2
}

async function cmdInit(args: string[]): Promise<number> {
  const { code, result } = await runInit({
    apiUrl: flag(args, '--api-url'),
    token: flag(args, '--token'),
    channel: flag(args, '--channel'),
    force: hasFlag(args, '--force'),
    yes: hasFlag(args, '--yes') || hasFlag(args, '-y'),
  })
  out(result)
  return code
}

async function cmdDoctor(): Promise<number> {
  const { code, report } = await runDoctor()
  out(report)
  return code
}

async function cmdServe(args: string[]): Promise<number> {
  const cfg = loadConfig()
  const bind = flag(args, '--bind')
  const port = parsePort(args)

  if (hasFlag(args, '--install-daemon')) {
    if (process.platform !== 'darwin') {
      out({
        error:
          'serve --install-daemon is macOS-only (it installs a launchd LaunchAgent). ' +
          'On Windows/Linux, run `snazi serve` under your own process manager (e.g. a ' +
          'Windows Service, systemd unit, or pm2).',
      })
      return 2
    }
    try {
      const r = installDaemon(cfg, { bind, port })
      out({
        ok: true,
        installed: r.plistPath,
        label: LABEL,
        bind: r.bind,
        port: r.port,
        node: r.node,
        cli: r.cli,
        next_steps: [
          `launchctl load -w ${r.plistPath}`,
          `# stop:   launchctl unload -w ${r.plistPath}`,
          `# Grant Full Disk Access to the node binary: ${r.node}`,
          `#   System Settings > Privacy & Security > Full Disk Access`,
        ],
      })
      return 0
    } catch (e) {
      out({ error: String(e instanceof Error ? e.message : e) })
      return 1
    }
  }

  try {
    const { server } = await startServer(cfg, { bind, port })
    // Keep the process alive until signalled; shut down cleanly.
    return await new Promise<number>((resolve) => {
      const shutdown = () => {
        server.close(() => resolve(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteListNew(args: string[]): Promise<number> {
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteListNew(cfg, channel, since)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteRead(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = normalizeAddress(positionals[0])
  if (!target) {
    out({ error: 'Usage: snazi remote-read <sender> [--channel <id>] [--since <minutes>]' })
    return 2
  }
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteRead(cfg, target, channel, since)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteCheck(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = normalizeAddress(positionals[0])
  if (!target) {
    out({ error: 'Usage: snazi remote-check <sender> --channel <id>' })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteCheck(cfg, target, channel)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteResolve(args: string[]): Promise<number> {
  // Name may be empty (-> whole address book). Treat the first positional as
  // the query; absent -> ''.
  const positionals = args.filter((a) => !a.startsWith('--'))
  const name = positionals[0] ?? ''
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteResolve(cfg, name, channel)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteLabel(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = normalizeAddress(positionals[0])
  const name = flag(args, '--name')
  if (!target || !name) {
    out({
      error: 'Usage: snazi remote-label <sender> --name <name> [--channel <id>]',
    })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteLabel(cfg, target, channel, name)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteSend(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const rawRecipient = positionals[0]
  const text = flag(args, '--text')
  if (!rawRecipient || text == null) {
    out({
      error: 'Usage: snazi remote-send <recipient> --text <message> [--channel <id>]',
    })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  let target: string
  try {
    target = validateRecipientAddress(rawRecipient)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 2
  }
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteSend(cfg, target, channel, text)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteStatus(): Promise<number> {
  const cfg = loadConfig()
  try {
    const { status, json } = await remoteHealth(cfg)
    out({ remoteUrl: cfg.remoteUrl ?? null, health_status: status, health: json })
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdStatus(): Promise<number> {
  const cfg = loadConfig()
  const reachable = await ping(cfg)
  out({
    config_path: CONFIG_PATH,
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…(${cfg.apiKey.length})` : null,
    channels: cfg.channels ?? [],
    server_reachable: reachable,
  })
  return reachable ? 0 : 1
}

function usage(): void {
  console.log(
    `snazi — on-demand message gate ("No messages for you.")

Setup:
  snazi init [--api-url <url>] [--token <tok>] [--channel <id>] [--force] [--yes]
                                                        Create/update ~/.snazi/config.json (interactive if a TTY)
  snazi doctor                                          Diagnose Node, config, connectivity, and channel access

Usage:
  snazi list-new [--channel <id>] [--since <minutes>]   Show WHO messaged + approval status (default 60m)
  snazi read <sender> [--channel <id>] [--since <min>]  Show message text — only if sender is approved
  snazi send <recipient> --text <message> [--channel <id>]  Send a message (never gated)
  snazi check <sender> --channel <id>                   Print one sender's approval status
  snazi channels list                                   List configured channels + adapter availability here
  snazi channels add <channel>                          Add a channel (e.g. imessage)
  snazi cache clear                                     Drop the cached approval statuses (force fresh checks)
  snazi status                                          Show config + platform + server connectivity

Approval status is cached on disk for a short TTL (default 5m; set
checkCacheTtlMs in config.json or SNAZI_CHECK_CACHE_TTL_MS) so repeated calls
don't re-hit the API. Pass --fresh to read/check/list-new to bypass it, or run
'snazi cache clear' right after you revoke someone.

Approvals are READ-ONLY here: approve/deny a sender in the web dashboard or via
a signed /decide link. The config token is a per-account READ token.

Serve mode (least-privilege HTTP gate for a remote agent over a tailnet):
  snazi serve [--bind <ip>] [--port <n>]                Start HTTP gate (/health,/list-new,/check,/read,POST /send)
  snazi serve --install-daemon [--bind <ip>] [--port <n>]  Install the launchd LaunchAgent (RunAtLoad/KeepAlive)

Remote client (the trusted agent side, calls a remote 'snazi serve'):
  snazi remote-status                                   Probe remoteUrl /health
  snazi remote-list-new [--channel <id>] [--since <min>]  WHO messaged on the remote host + status
  snazi remote-check <sender> --channel <id>            One sender's status (remote)
  snazi remote-read <sender> [--channel <id>] [--since <min>]  Message text (remote) — only if approved
  snazi remote-send <recipient> --text <msg> [--channel <id>]  Send a message (remote; never gated)
  snazi remote-resolve [<name>] [--channel <id>]        Resolve a name → sender address(es) (empty = address book)
  snazi remote-label <sender> --name <name> [--channel <id>]  Set a sender's display name (label only; cannot open the gate)

The server manages an approve/deny list only. It stores no messages.
Reading is gated; sending is not. serve binds the tailnet IP (100.x) or
127.0.0.1 — never 0.0.0.0.`
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)

  let code = 0
  switch (cmd) {
    case 'init':
      code = await cmdInit(rest)
      break
    case 'doctor':
      code = await cmdDoctor()
      break
    case 'list-new':
      code = await cmdListNew(rest)
      break
    case 'read':
      code = await cmdRead(rest)
      break
    case 'send':
      code = await cmdSend(rest)
      break
    case 'check':
      code = await cmdCheck(rest)
      break
    case 'channels':
      code = await cmdChannels(rest)
      break
    case 'cache':
      code = await cmdCache(rest)
      break
    case 'status':
      code = await cmdStatus()
      break
    case 'serve':
      code = await cmdServe(rest)
      break
    case 'remote-list-new':
      code = await cmdRemoteListNew(rest)
      break
    case 'remote-read':
      code = await cmdRemoteRead(rest)
      break
    case 'remote-send':
      code = await cmdRemoteSend(rest)
      break
    case 'remote-check':
      code = await cmdRemoteCheck(rest)
      break
    case 'remote-resolve':
      code = await cmdRemoteResolve(rest)
      break
    case 'remote-label':
      code = await cmdRemoteLabel(rest)
      break
    case 'remote-status':
      code = await cmdRemoteStatus()
      break
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage()
      code = 0
      break
    default:
      out({ error: `Unknown command: ${cmd}` })
      usage()
      code = 2
  }
  process.exit(code)
}

main().catch((e) => {
  out({ error: String(e instanceof Error ? e.message : e) })
  process.exit(1)
})
