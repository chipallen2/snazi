#!/usr/bin/env node
/**
 * soup-nazi — on-demand iMessage gate.
 *
 *   "No messages for you."
 *
 * This CLI is the LOCAL gate. It runs on Chip's Mac on demand (NOT a daemon).
 * - list-new : reveals WHO sent recent messages + their approval status. Never WHAT.
 * - read     : reveals message TEXT for ONE sender, but ONLY if approved by the server.
 * - status   : prints config + server connectivity.
 *
 * The server stores no messages. This CLI stores nothing. Content is read live
 * from the local Messages database and printed only when the gate opens.
 */
import { loadConfig, CONFIG_PATH } from './config'
import { checkSender, ping } from './api'
import { listInboundSenders, readMessagesFrom } from './chatdb'

const CHANNEL = 'imessage'

function parseSince(args: string[], def = 60): number {
  const i = args.indexOf('--since')
  if (i !== -1 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return def
}

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2))
}

async function cmdListNew(args: string[]): Promise<number> {
  const since = parseSince(args, 60)
  const cfg = loadConfig()
  const senders = listInboundSenders(since)

  const results = []
  for (const s of senders) {
    let status: string
    try {
      status = await checkSender(cfg, CHANNEL, s.sender)
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
  // The sender is the first positional arg (flags like --since are filtered out).
  const positionals = args.filter((a) => !a.startsWith('--'))
  const target = positionals[0]
  if (!target) {
    out({ error: 'Usage: soup-nazi read <sender> [--since <minutes>]' })
    return 2
  }
  const since = parseSince(args, 60)
  const cfg = loadConfig()

  // GATE: check approval BEFORE touching any message text.
  let status: string
  try {
    status = await checkSender(cfg, CHANNEL, target)
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

async function cmdStatus(): Promise<number> {
  const cfg = loadConfig()
  const reachable = await ping(cfg)
  out({
    config_path: CONFIG_PATH,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…(${cfg.apiKey.length})` : null,
    channel: CHANNEL,
    server_reachable: reachable,
  })
  return reachable ? 0 : 1
}

function usage(): void {
  console.log(
    `soup-nazi — on-demand iMessage gate ("No messages for you.")

Usage:
  soup-nazi list-new [--since <minutes>]   Show WHO messaged + approval status (default 60m)
  soup-nazi read <sender> [--since <min>]  Show message text — only if sender is approved
  soup-nazi status                          Show config + server connectivity

The server manages an approve/deny list only. It stores no messages.`
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
    case 'status':
      code = await cmdStatus()
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
