#!/usr/bin/env node
/**
 * snazi — on-demand iMessage gate.
 *
 *   "No messages for you."
 *
 * This CLI is the LOCAL gate. It runs on Chip's Mac on demand (NOT a daemon).
 * - list-new : reveals WHO sent recent messages + their approval status. Never WHAT.
 * - read     : reveals message TEXT for ONE sender, but ONLY if approved by the server.
 * - check    : prints a single sender's approval status.
 * - approve  : approve a sender (admin key).
 * - deny     : deny a sender (admin key).
 * - channels : list/add configured channels.
 * - status   : prints config + server connectivity.
 *
 * The server stores no messages. This CLI stores nothing. Content is read live
 * from the local Messages database and printed only when the gate opens.
 */
import { loadConfig, saveConfig, CONFIG_PATH } from './config'
import { checkSender, setSender, ping } from './api'
import { listInboundSenders, readMessagesFrom } from './chatdb'
import { startServer } from './server'
import { remoteListNew, remoteRead, remoteCheck, remoteHealth } from './client'
import { installDaemon, LABEL } from './daemon'

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
  const cfg = loadConfig()
  const senders = listInboundSenders(since)

  const results = []
  for (const s of senders) {
    let status: string
    try {
      status = await checkSender(cfg, channel, s.sender)
    } catch (e) {
      status = `error:${String(e instanceof Error ? e.message : e)}`
    }
    results.push({
      sender: s.sender,
      message_count: s.message_count,
      latest_at: s.latest_at,
      status,
    })
  }
  out(results)
  return 0
}

async function cmdRead(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = positionals[0]
  if (!target) {
    out({ error: 'Usage: snazi read <sender> [--channel <id>] [--since <minutes>]' })
    return 2
  }
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()

  // GATE: check approval BEFORE touching any message text.
  let status: string
  try {
    status = await checkSender(cfg, channel, target)
  } catch (e) {
    out({ error: `Approval check failed: ${String(e)}` })
    return 1
  }

  if (status !== 'approved') {
    out({ error: 'Sender not approved. No messages for you.', status })
    return 1
  }

  const messages = readMessagesFrom(target, since)
  out({ sender: target, status, since_minutes: since, messages })
  return 0
}

async function cmdCheck(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = positionals[0]
  if (!target) {
    out({ error: 'Usage: snazi check <sender> --channel <id>' })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadConfig()
  try {
    const status = await checkSender(cfg, channel, target)
    out({ channel, sender: target, status })
    return 0
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdSet(
  args: string[],
  status: 'approved' | 'denied'
): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = positionals[0]
  const verb = status === 'approved' ? 'approve' : 'deny'
  if (!target) {
    out({ error: `Usage: snazi ${verb} <sender> --channel <id>${status === 'approved' ? ' [--label <name>]' : ''}` })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const label = status === 'approved' ? flag(args, '--label') : undefined
  const cfg = loadConfig()
  try {
    await setSender(cfg, channel, target, status, label)
    out({ ok: true, channel, sender: target, status, label: label ?? null })
    return 0
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdChannels(args: string[]): Promise<number> {
  const sub = args[0]
  const cfg = loadConfig()
  if (sub === 'list' || sub === undefined) {
    out({ channels: cfg.channels ?? [] })
    return 0
  }
  if (sub === 'add') {
    const channel = args[1]
    if (!channel) {
      out({ error: 'Usage: snazi channels add <channel>' })
      return 2
    }
    const channels = new Set(cfg.channels ?? [])
    channels.add(channel)
    cfg.channels = [...channels]
    saveConfig(cfg)
    out({ ok: true, channels: cfg.channels })
    return 0
  }
  out({ error: `Unknown channels subcommand: ${sub}. Use 'list' or 'add'.` })
  return 2
}

async function cmdServe(args: string[]): Promise<number> {
  const cfg = loadConfig()
  const bind = flag(args, '--bind')
  const port = parsePort(args)

  if (hasFlag(args, '--install-daemon')) {
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
  const target = positionals[0]
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
  const target = positionals[0]
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
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…(${cfg.apiKey.length})` : null,
    adminKey: cfg.adminKey ? `${cfg.adminKey.slice(0, 6)}…(${cfg.adminKey.length})` : null,
    channels: cfg.channels ?? [],
    server_reachable: reachable,
  })
  return reachable ? 0 : 1
}

function usage(): void {
  console.log(
    `snazi — on-demand iMessage gate ("No messages for you.")

Usage:
  snazi list-new [--channel <id>] [--since <minutes>]   Show WHO messaged + approval status (default 60m)
  snazi read <sender> [--channel <id>] [--since <min>]  Show message text — only if sender is approved
  snazi check <sender> --channel <id>                   Print one sender's approval status
  snazi approve <sender> --channel <id> [--label <name>] Approve a sender (admin key)
  snazi deny <sender> --channel <id>                    Deny a sender (admin key)
  snazi channels list                                   List configured channels
  snazi channels add <channel>                          Add a channel (e.g. imessage)
  snazi status                                          Show config + server connectivity

Serve mode (least-privilege HTTP gate for a remote agent over a tailnet):
  snazi serve [--bind <ip>] [--port <n>]                Start read-only HTTP gate (/health,/list-new,/check,/read)
  snazi serve --install-daemon [--bind <ip>] [--port <n>]  Install the launchd LaunchAgent (RunAtLoad/KeepAlive)

Remote client (the trusted agent side, calls a remote 'snazi serve'):
  snazi remote-status                                   Probe remoteUrl /health
  snazi remote-list-new [--channel <id>] [--since <min>]  WHO messaged on the remote host + status
  snazi remote-check <sender> --channel <id>            One sender's status (remote)
  snazi remote-read <sender> [--channel <id>] [--since <min>]  Message text (remote) — only if approved

The server manages an approve/deny list only. It stores no messages.
serve is READ-ONLY (no approve/deny over HTTP), bearer-token protected, and
binds the tailnet IP (100.x) or 127.0.0.1 — never 0.0.0.0.`
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)

  let code = 0
  switch (cmd) {
    case 'list-new':
      code = await cmdListNew(rest)
      break
    case 'read':
      code = await cmdRead(rest)
      break
    case 'check':
      code = await cmdCheck(rest)
      break
    case 'approve':
      code = await cmdSet(rest, 'approved')
      break
    case 'deny':
      code = await cmdSet(rest, 'denied')
      break
    case 'channels':
      code = await cmdChannels(rest)
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
    case 'remote-check':
      code = await cmdRemoteCheck(rest)
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
