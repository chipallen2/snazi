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
import * as fs from 'fs'
import {
  loadConfig,
  loadRemoteConfig,
  saveConfig,
  readConfigIfPresent,
  normalizeChannels,
  CONFIG_PATH,
  type ChannelConfig,
} from './config'
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
  remoteAction,
  remoteFilterCreate,
  remoteFilterList,
  remoteFilterGet,
  remoteFilterUpdate,
  remoteFilterDelete,
  remoteCalendarList,
  remoteCalendarCreate,
  type RemoteFilterSpec,
  type RemoteCalendarEventSpec,
} from './client'
import { installDaemon, LABEL } from './daemon'
import {
  serviceStart,
  serviceStop,
  serviceRestart,
  serviceStatus,
  ensureServeToken,
  writeServePid,
  clearServePid,
} from './service'
import { runInit, runInitAgent } from './init'
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

  const { adapter, ctx, error } = resolveReadableAdapter(channel, cfg)
  if (!adapter || !ctx) {
    out({ error })
    return 1
  }
  let senders
  try {
    senders = await adapter.listInboundSenders(ctx, since)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
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
  const { adapter, ctx, error } = resolveReadableAdapter(channel, cfg)
  if (!adapter || !ctx) {
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

  let messages
  try {
    messages = await adapter.readMessagesFrom(ctx, target, since)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
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
  const subject = flag(args, '--subject')
  const fromOverride = flag(args, '--from')
  const replyTo = flag(args, '--reply-to')
  const replyAll = hasFlag(args, '--reply-all')
  const htmlFile = flag(args, '--html-file')
  const htmlText = flag(args, '--html-text')

  let html: string | undefined
  if (htmlFile != null) {
    try {
      html = fs.readFileSync(htmlFile, 'utf8')
    } catch (e) {
      out({ error: `Could not read --html-file: ${String(e instanceof Error ? e.message : e)}` })
      return 2
    }
  } else if (htmlText != null) {
    html = htmlText
  }

  if (!rawRecipient || (text == null && html == null)) {
    out({
      error:
        'Usage: snazi send <recipient> (--text <message> | --html-file <path> | ' +
        '--html-text <html>) [--subject <s>] [--from <alias>] [--reply-to <messageId>] ' +
        '[--reply-all] [--channel <id>]',
    })
    return 2
  }
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  // Lenient read: sending an iMessage needs no config at all; email channels
  // pull their local credentials from it when present.
  const cfg = readConfigIfPresent() ?? undefined

  let target: string
  try {
    // Accepts phone (E.164) OR email, so it works for every channel type.
    target = validateRecipientAddress(rawRecipient)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 2
  }

  // Sending is NEVER gated — the soup nazi only blocks reading.
  const { adapter, ctx, error } = resolveSendableAdapter(channel, cfg)
  if (!adapter?.sendMessage || !ctx) {
    out({ error })
    return 1
  }
  try {
    const opts: {
      subject?: string
      html?: string
      from?: string
      replyToMessageId?: string
      replyAll?: boolean
    } = {}
    if (subject != null) opts.subject = subject
    if (html != null) opts.html = html
    if (fromOverride != null) opts.from = fromOverride
    if (replyTo != null) opts.replyToMessageId = replyTo
    if (replyAll) opts.replyAll = true
    await adapter.sendMessage(
      ctx,
      target,
      text ?? '',
      Object.keys(opts).length ? opts : undefined
    )
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
    const channels = normalizeChannels(cfg?.channels).map((inst) => {
      const adapter = getAdapter(inst.type)
      const ctx = {
        id: inst.id,
        type: inst.type,
        name: inst.name ?? inst.id,
        auth: inst.auth ?? {},
      }
      const av = adapter
        ? adapter.availability(ctx)
        : { available: false, reason: `no local adapter for type '${inst.type}' on this build` }
      return {
        id: inst.id,
        type: inst.type,
        name: inst.name ?? inst.id,
        available_here: av.available,
        reason: av.reason ?? null,
      }
    })
    // The channel TYPES this build can drive locally.
    const types = listAdapters().map((a) => ({
      type: a.id,
      display_name: a.displayName,
      platforms: a.platforms,
    }))
    out({ channels, types })
    return 0
  }

  if (sub === 'add') {
    const id = args[1]
    if (!id || id.startsWith('--')) {
      out({
        error:
          'Usage: snazi channels add <id> [--type <type>] [--name <name>] ' +
          '[--client-id <id>] [--client-secret <secret>] [--refresh-token <tok>] ' +
          '[--tenant <id>] [--user <email>]',
      })
      return 2
    }
    const cfg = loadConfig()
    const type = flag(args, '--type') ?? id
    const name = flag(args, '--name') ?? id

    const auth: NonNullable<ChannelConfig['auth']> = {}
    const clientId = flag(args, '--client-id')
    const clientSecret = flag(args, '--client-secret')
    const refreshToken = flag(args, '--refresh-token')
    const tenant = flag(args, '--tenant')
    const user = flag(args, '--user')
    if (clientId) auth.clientId = clientId
    if (clientSecret) auth.clientSecret = clientSecret
    if (refreshToken) auth.refreshToken = refreshToken
    if (tenant) auth.tenantId = tenant
    if (user) auth.user = user

    const instance: ChannelConfig = { id, type, name }
    if (Object.keys(auth).length > 0) instance.auth = auth

    // Replace any existing instance with the same id, then append.
    const list = normalizeChannels(cfg.channels).filter((c) => c.id !== id)
    list.push(instance)
    cfg.channels = list
    saveConfig(cfg)

    const known = getAdapter(type)
    out({
      ok: true,
      // Never echo secrets back.
      channel: { id, type, name },
      channels: list.map((c) => c.id),
      note: known
        ? undefined
        : `Type '${type}' has no local adapter on this build; this channel can still be used with remote-* against a host that supports it.`,
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
    serve: hasFlag(args, '--serve') || undefined,
  })
  out(result)
  return code
}

async function cmdInitAgent(args: string[]): Promise<number> {
  const { code, result } = await runInitAgent({
    url: flag(args, '--url'),
    token: flag(args, '--token'),
    readToken: flag(args, '--read-token'),
    apiUrl: flag(args, '--api-url'),
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
        tip: "Prefer 'snazi start' / 'snazi stop' / 'snazi restart' — they install AND (un)load the service for you, cross-platform.",
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
    // Record our PID so `snazi stop` can find us (used on Windows; harmless
    // elsewhere where the service manager already tracks the process).
    writeServePid()
    // Keep the process alive until signalled; shut down cleanly.
    return await new Promise<number>((resolve) => {
      const shutdown = () => {
        clearServePid()
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

async function cmdStart(args: string[]): Promise<number> {
  const cfg = loadConfig()
  const bind = flag(args, '--bind')
  const port = parsePort(args)
  let token: { token: string; generated: boolean }
  try {
    // serve needs a bearer token; mint + save one on first start.
    token = ensureServeToken(cfg)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
  let res
  try {
    res = await serviceStart(cfg, { bind, port })
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
  if (token.generated) {
    res.result.serveToken = token.token
    const notes = Array.isArray(res.result.notes) ? (res.result.notes as string[]) : []
    notes.unshift(
      `Generated a connect token (serveToken) and saved it to ${CONFIG_PATH}. On your agent machine, run 'snazi init-agent' and give it this token: ${token.token}`
    )
    res.result.notes = notes
  }
  out(res.result)
  return res.code
}

async function cmdStop(): Promise<number> {
  const res = serviceStop()
  out(res.result)
  return res.code
}

async function cmdRestart(args: string[]): Promise<number> {
  const cfg = loadConfig()
  const bind = flag(args, '--bind')
  const port = parsePort(args)
  let token: { token: string; generated: boolean }
  try {
    token = ensureServeToken(cfg)
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
  let res
  try {
    res = await serviceRestart(cfg, { bind, port })
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
  if (token.generated) {
    res.result.serveToken = token.token
    const notes = Array.isArray(res.result.notes) ? (res.result.notes as string[]) : []
    notes.unshift(
      `Generated a connect token (serveToken) and saved it to ${CONFIG_PATH}. On your agent machine, run 'snazi init-agent' and give it this token: ${token.token}`
    )
    res.result.notes = notes
  }
  out(res.result)
  return res.code
}

async function cmdRemoteListNew(args: string[]): Promise<number> {
  const since = parseSince(args, 60)
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadRemoteConfig()
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
  const cfg = loadRemoteConfig()
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
  const cfg = loadRemoteConfig()
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
  const cfg = loadRemoteConfig()
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
  const cfg = loadRemoteConfig()
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
  const subject = flag(args, '--subject')
  const fromOverride = flag(args, '--from')
  const replyTo = flag(args, '--reply-to')
  const replyAll = hasFlag(args, '--reply-all')
  const htmlFile = flag(args, '--html-file')
  const htmlText = flag(args, '--html-text')

  // Resolve the HTML body (if any) from --html-file or --html-text.
  let html: string | undefined
  if (htmlFile != null) {
    try {
      html = fs.readFileSync(htmlFile, 'utf8')
    } catch (e) {
      out({ error: `Could not read --html-file: ${String(e instanceof Error ? e.message : e)}` })
      return 2
    }
  } else if (htmlText != null) {
    html = htmlText
  }

  // Need a recipient, and at least one body source (text or html).
  if (!rawRecipient || (text == null && html == null)) {
    out({
      error:
        'Usage: snazi remote-send <recipient> (--text <message> | ' +
        '--html-file <path> | --html-text <html>) [--subject <s>] [--from <alias>] ' +
        '[--reply-to <messageId>] [--reply-all] [--channel <id>]',
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
  const cfg = loadRemoteConfig()
  try {
    const opts: {
      subject?: string
      html?: string
      from?: string
      replyToMessageId?: string
      replyAll?: boolean
    } = {}
    if (subject != null) opts.subject = subject
    if (html != null) opts.html = html
    if (fromOverride != null) opts.from = fromOverride
    if (replyTo != null) opts.replyToMessageId = replyTo
    if (replyAll) opts.replyAll = true
    // text may be omitted for an HTML-only send; the server/adapter derives a
    // plaintext alternative from the HTML in that case.
    const { status, json } = await remoteSend(cfg, target, channel, text ?? '', opts)
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteAction(args: string[]): Promise<number> {
  // First positional after `remote-action` is the action id.
  const positionals = args.filter((a) => !a.startsWith('--'))
  const action = positionals[0]
  const validActions = ['archive', 'delete', 'markRead', 'markUnread']
  if (!action || !validActions.includes(action)) {
    out({
      error:
        'Usage: snazi remote-action <archive|delete|markRead|markUnread> ' +
        '(--sender <addr> | --message-id <id>) --channel <id> [--since <min>]',
    })
    return 2
  }
  const rawSender = flag(args, '--sender')
  const messageId = flag(args, '--message-id')
  if (!rawSender && !messageId) {
    out({ error: 'Provide --sender <addr> or --message-id <id>.' })
    return 2
  }
  const sender = rawSender ? normalizeAddress(rawSender) : undefined
  const channel = flag(args, '--channel') ?? DEFAULT_CHANNEL
  const since = hasFlag(args, '--since') ? parseSince(args, 1440) : undefined
  const cfg = loadRemoteConfig()
  try {
    const { status, json } = await remoteAction(cfg, {
      sender,
      messageId,
      channel,
      action,
      sinceMinutes: since,
    })
    out(json)
    return status >= 200 && status < 300 ? 0 : 1
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

/** Collect the filter/rule spec flags shared by create + update. */
function filterSpecFromArgs(args: string[]): RemoteFilterSpec {
  const spec: RemoteFilterSpec = {}
  const from = flag(args, '--from')
  const to = flag(args, '--to')
  const subject = flag(args, '--subject')
  const query = flag(args, '--query')
  const action = flag(args, '--action')
  const labelId = flag(args, '--label-id')
  const forwardTo = flag(args, '--forward-to')
  const folderId = flag(args, '--folder-id')
  const name = flag(args, '--name')
  if (from) spec.from = from
  if (to) spec.to = to
  if (subject) spec.subject = subject
  if (query) spec.query = query
  if (action) spec.action = action
  if (labelId) spec.labelId = labelId
  if (forwardTo) spec.forwardTo = forwardTo
  if (folderId) spec.folderId = folderId
  if (name) spec.name = name
  return spec
}

async function cmdRemoteFilter(args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  const channel = flag(rest, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadRemoteConfig()
  const usageErr = () => {
    out({
      error:
        'Usage: snazi remote-filter <create|list|get|update|delete> --channel <id> [flags]\n' +
        '  create: [--from <a>] [--to <a>] [--subject <s>] [--query <q>] --action <delete|archive|label|markRead|forward> [--label-id <id>] [--forward-to <addr>] [--folder-id <id>] [--name <n>]\n' +
        '  list  : (no extra flags)\n' +
        '  get   : --id <FILTER_ID>\n' +
        '  update: --id <RULE_ID> [spec flags]   (Outlook only)\n' +
        '  delete: --id <FILTER_ID>',
    })
    return 2
  }
  try {
    if (sub === 'create') {
      const spec = filterSpecFromArgs(rest)
      const { status, json } = await remoteFilterCreate(cfg, channel, spec)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    if (sub === 'list') {
      const { status, json } = await remoteFilterList(cfg, channel)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    if (sub === 'get') {
      const id = flag(rest, '--id')
      if (!id) return usageErr()
      const { status, json } = await remoteFilterGet(cfg, channel, id)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    if (sub === 'update') {
      const id = flag(rest, '--id')
      if (!id) return usageErr()
      const spec = filterSpecFromArgs(rest)
      const { status, json } = await remoteFilterUpdate(cfg, channel, id, spec)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    if (sub === 'delete') {
      const id = flag(rest, '--id')
      if (!id) return usageErr()
      const { status, json } = await remoteFilterDelete(cfg, channel, id)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    return usageErr()
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteCalendar(args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  const channel = flag(rest, '--channel') ?? DEFAULT_CHANNEL
  const cfg = loadRemoteConfig()
  const usageErr = () => {
    out({
      error:
        'Usage: snazi remote-calendar <list|create> --channel <id> [flags]\n' +
        '  list  : (no extra flags) — shows calendar ids + names\n' +
        '  create: --calendar <name-or-id> --subject <title> --start <YYYY-MM-DD|ISO>\n' +
        '          [--end <YYYY-MM-DD|ISO>] [--all-day] [--tz <IANA>]\n' +
        '          all-day --end is the INCLUSIVE last day (Graph day-after handled for you).',
    })
    return 2
  }
  try {
    if (sub === 'list') {
      const { status, json } = await remoteCalendarList(cfg, channel)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    if (sub === 'create') {
      const calendar = flag(rest, '--calendar')
      const subject = flag(rest, '--subject')
      const start = flag(rest, '--start')
      if (!calendar || !subject || !start) {
        out({ error: 'create requires --calendar, --subject, and --start.' })
        return 2
      }
      const spec: RemoteCalendarEventSpec = {
        calendar,
        subject,
        start,
        allDay: hasFlag(rest, '--all-day'),
      }
      const end = flag(rest, '--end')
      const tz = flag(rest, '--tz')
      if (end) spec.end = end
      if (tz) spec.timeZone = tz
      const { status, json } = await remoteCalendarCreate(cfg, channel, spec)
      out(json)
      return status >= 200 && status < 300 ? 0 : 1
    }
    return usageErr()
  } catch (e) {
    out({ error: String(e instanceof Error ? e.message : e) })
    return 1
  }
}

async function cmdRemoteStatus(): Promise<number> {
  const cfg = loadRemoteConfig()
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
  // Best-effort background-service readout (start/stop/restart). Never throws.
  const service = await serviceStatus(cfg)
  out({
    config_path: CONFIG_PATH,
    platform: `${process.platform}/${process.arch}`,
    node: process.versions.node,
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…(${cfg.apiKey.length})` : null,
    channels: normalizeChannels(cfg.channels).map((c) => ({ id: c.id, type: c.type })),
    server_reachable: reachable,
    service,
  })
  return reachable ? 0 : 1
}

function getVersion(): string {
  try {
    // dist/cli.js -> ../package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../package.json').version as string) ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function usage(): void {
  console.log(
    `snazi — message gate ("No messages for you.")  v${getVersion()}

Setup:
  snazi init [--api-url <url>] [--token <tok>] [--channel <id>] [--serve] [--force] [--yes]
                                                        Set up the MESSAGES MACHINE (has your messages). Writes ~/.snazi/config.json
                                                        --serve also installs + starts the background gate (see 'snazi start')
  snazi init-agent [--url <url>] [--token <tok>] [--read-token <tok>] [--api-url <url>] [--yes]
                                                        Set up an AGENT MACHINE (runs your AI) to reach a messages machine's gate
                                                        --read-token (read-only) lets the agent mint one-tap approve links itself
  snazi doctor                                          Diagnose Node, config, connectivity, and channel access

Usage:
  snazi list-new [--channel <id>] [--since <minutes>]   Show WHO messaged + approval status (default 60m)
  snazi read <sender> [--channel <id>] [--since <min>]  Show message text — only if sender is approved
  snazi send <recipient> --text <message> [--channel <id>]  Send a message (never gated)
                                                        Email: add --html-file <path>|--html-text <html> [--subject <s>] to send HTML
                                                        Reply (real threading): add --reply-to <messageId> [--reply-all] (id comes from a read row)
  snazi check <sender> --channel <id>                   Print one sender's approval status
  snazi channels list                                   List configured channels (instances) + adapter availability here
  snazi channels add <id> [--type <t>] [--name <n>] [auth flags]   Configure a channel instance (e.g. id gmail-work, type gmail)
  snazi cache clear                                     Drop the cached approval statuses (force fresh checks)
  snazi status                                          Show config + platform + server connectivity

Approval status is cached on disk for a short TTL (default 5m; set
checkCacheTtlMs in config.json or SNAZI_CHECK_CACHE_TTL_MS) so repeated calls
don't re-hit the API. Pass --fresh to read/check/list-new to bypass it, or run
'snazi cache clear' right after you revoke someone.

Approvals are READ-ONLY here: approve/deny a sender in the web dashboard or via
a signed /decide link. The config token is a per-account READ token.

Serve mode (least-privilege HTTP gate for a remote agent over a tailnet):
  snazi start [--bind <ip>] [--port <n>]                Run the gate in the background + auto-start at login (mac/Linux/Windows)
  snazi stop                                            Stop the background gate and remove auto-start
  snazi restart [--bind <ip>] [--port <n>]              Restart the background gate (picks up config changes)
  snazi serve [--bind <ip>] [--port <n>]                Run the HTTP gate in the FOREGROUND (no background service)
  snazi serve --install-daemon [--bind <ip>] [--port <n>]  (advanced) Write the launchd plist without loading it

'snazi start' generates a serveToken if you don't have one, installs the right
service for your OS (launchd / systemd --user / Task Scheduler), starts it, and
checks /health. No launchctl/systemctl/schtasks commands to remember.

Agent machine (set up with 'snazi init-agent'; calls your messages machine's gate):
  snazi remote-status                                   Probe remoteUrl /health
  snazi remote-list-new [--channel <id>] [--since <min>]  WHO messaged on the remote host + status
  snazi remote-check <sender> --channel <id>            One sender's status (remote)
  snazi remote-read <sender> [--channel <id>] [--since <min>]  Message text (remote) — only if approved
  snazi remote-send <recipient> --text <msg> [--channel <id>]  Send a message (remote; never gated)
                                                        Email: add --html-file <path>|--html-text <html> [--subject <s>] to send HTML
                                                        Reply (real threading): add --reply-to <messageId> [--reply-all]; subject auto-derived. read rows now include each message id
  snazi remote-resolve [<name>] [--channel <id>]        Resolve a name → sender address(es) (empty = address book)
  snazi remote-label <sender> --name <name> [--channel <id>]  Set a sender's display name (label only; cannot open the gate)
  snazi remote-action <archive|delete|markRead|markUnread> (--sender <addr> | --message-id <id>) [--channel <id>] [--since <min>]
                                                        Perform a message action (remote; never gated)
  snazi remote-filter <create|list|get|update|delete> --channel <id> [flags]
                                                        Manage Gmail filters / Outlook rules (remote; never gated)
                                                        create: --action <delete|archive|label|markRead|forward> plus a match
                                                        (--from/--to/--subject/--query). get/update/delete take --id. update
                                                        is Outlook-only (Gmail has no update: delete + recreate).
  snazi remote-calendar <list|create> --channel <id> [flags]
                                                        Manage calendar events (remote; OPEN/UNGATED — no approval link)
                                                        list  : show calendar ids + names
                                                        create: --calendar <name-or-id> --subject <title> --start <YYYY-MM-DD|ISO>
                                                                [--end <YYYY-MM-DD|ISO>] [--all-day] [--tz <IANA>]
                                                                all-day --end is the INCLUSIVE last day (Outlook: currently).

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
    case 'init-agent':
      code = await cmdInitAgent(rest)
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
    case 'start':
      code = await cmdStart(rest)
      break
    case 'stop':
      code = await cmdStop()
      break
    case 'restart':
      code = await cmdRestart(rest)
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
    case 'remote-action':
      code = await cmdRemoteAction(rest)
      break
    case 'remote-filter':
      code = await cmdRemoteFilter(rest)
      break
    case 'remote-calendar':
      code = await cmdRemoteCalendar(rest)
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
    case '-v':
    case '--version':
    case 'version':
      console.log(getVersion())
      code = 0
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
