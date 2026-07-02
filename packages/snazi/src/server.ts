/**
 * snazi serve — least-privilege HTTP gate.
 *
 *   "No messages for you."
 *
 * Exposes ONLY the read-only gated message operations over HTTP so a REMOTE
 * trusted agent (reachable only over a private Tailscale tailnet) can use them
 * without an SSH shell. This is deliberately a tiny, read-only surface:
 *
 *   GET  /health                     -> { ok, version }            (no auth)
 *   GET  /list-new?channel&since     -> WHO + status + label        (bearer)
 *   GET  /read?sender&channel&since  -> text ONLY if approved       (bearer)
 *   GET  /check?sender&channel       -> { status, label }           (bearer)
 *   GET  /resolve?name&channel       -> name->address address book   (bearer)
 *   POST /label {sender,channel,name}-> set a sender's display label (bearer)
 *   POST /send  {recipient,channel,text} -> send a message (bearer, never gated)
 *   POST /action {sender,channel,action,sinceMinutes?} -> perform action (bearer, never gated)
 *
 * It REUSES the same gate (api.ts) and the same DB reader (chatdb.ts) as the
 * CLI. There is no approve/deny here — APPROVAL mutations stay CLI/dashboard-
 * only. The ONLY write this surface can make is POST /label, which sets a
 * sender's non-privileged display name via an UPDATE-only web endpoint: it can
 * never create a row or change `status`, so it cannot open the gate. There is
 * no shell, no arbitrary file access, no path that bypasses the gate.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as os from 'os'
import type { Config } from './config'
import { listSenders, setLabel, buildLabelMap, type CheckStatus, type SenderRecord } from './api'
import { checkSenderCached } from './cache'
import {
  resolveReadableAdapter,
  resolveSendableAdapter,
  resolveActionableAdapter,
  resolveFilterAdapter,
  type FilterSpec,
} from './channels'
import { normalizeAddress, validateRecipientAddress } from './address'
import { MAX_MESSAGE_LEN } from './imessage-send'
import { buildContactIndex, type ContactIndex } from './contacts'

/**
 * Build the macOS Contacts index for ONE request, best-effort. NEVER throws:
 * any failure (no DB, no permission, non-macOS, better-sqlite3 missing) yields
 * an empty index so enrichment degrades to `contact_name: null` and the gate
 * keeps working with zero Contacts access.
 *
 * SECURITY: the returned name is DISPLAY-ONLY. It is never consulted by the
 * read gate (handleRead checks `status === 'approved'` and nothing else) and
 * is already sanitized (control-char-stripped + length-capped) by contacts.ts.
 */
function contactIndexForRequest(): ContactIndex {
  try {
    return buildContactIndex()
  } catch {
    return { size: 0, get: () => null }
  }
}

// Read version without importing JSON at compile time (keeps build simple).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = (() => {
  try {
    // dist/server.js -> ../package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const DEFAULT_PORT = 8787
const DEFAULT_CHANNEL = 'imessage'
const MAX_SINCE_MIN = 7 * 24 * 60 // 7 days
const DEFAULT_SINCE_MIN = 60
const MAX_SENDER_LEN = 128
const MAX_NAME_LEN = 64
// Cap POST bodies hard: /label only needs a few short fields. /action carries
// a slightly larger body (sender + action + window), so allow up to 8 KiB.
const MAX_BODY_BYTES = 8 * 1024
const MAX_LABEL_BODY_BYTES = 4 * 1024 // /label only needs a few short fields
const CHANNEL_RE = /^[a-z0-9_-]+$/i
// iMessage senders are phone numbers (+1555…) or emails. Keep it tight.
const SENDER_RE = /^[A-Za-z0-9_.+@-]+$/
// Names are free-form human text but must not carry control chars (defends
// log/terminal injection) and are length-capped. Keep in sync with
// packages/web/src/app/api/senders/label/route.ts (MAX_LABEL_LEN, LABEL_CTRL_RE).
// eslint-disable-next-line no-control-regex
const NAME_CTRL_RE = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const TEXT_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface ServeOptions {
  bind?: string
  port?: number
}

/**
 * Find this host's Tailscale IP (CGNAT range 100.64.0.0/10) if present.
 * Returns undefined if not on a tailnet.
 */
export function detectTailscaleIp(): string | undefined {
  const ifaces = os.networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue
      const parts = a.address.split('.').map((n) => parseInt(n, 10))
      // 100.64.0.0/10  => first octet 100, second octet 64..127
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
        return a.address
      }
    }
  }
  return undefined
}

/**
 * Resolve the bind address with the security policy:
 *   flag/config override  ->  tailscale IP  ->  127.0.0.1
 * NEVER 0.0.0.0 (or ::) — that would expose the gate beyond the tailnet.
 */
export function resolveBind(cfg: Config, opts: ServeOptions): string {
  const requested = opts.bind ?? cfg.serveBind
  if (requested) {
    const r = requested.trim()
    if (r === '0.0.0.0' || r === '::' || r === '*') {
      throw new Error(
        `Refusing to bind ${r}: that exposes the gate to every network. ` +
          `Bind your Tailscale 100.x IP (tailnet-only) or 127.0.0.1 (with 'tailscale serve').`
      )
    }
    return r
  }
  return detectTailscaleIp() ?? '127.0.0.1'
}

function resolvePort(cfg: Config, opts: ServeOptions): number {
  const p = opts.port ?? cfg.servePort ?? DEFAULT_PORT
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`Invalid port: ${p}`)
  }
  return p
}

/** Constant-time bearer check. Never logs the token. */
function bearerOk(authHeader: string | undefined, expected: string): boolean {
  if (!expected) return false
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  // Exact token after the "Bearer " prefix — no trimming, so stray whitespace
  // fails closed rather than silently authenticating.
  const provided = authHeader.slice('Bearer '.length)
  // Hash both to fixed length so we never branch on length and never throw on
  // a length mismatch inside timingSafeEqual.
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    // This is a private API surface; deny embedding/sniffing.
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function parseChannel(v: string | null): string {
  const c = (v ?? DEFAULT_CHANNEL).trim()
  if (!CHANNEL_RE.test(c)) throw new Error('Invalid channel.')
  return c
}

function parseSender(v: string | null): string {
  const raw = (v ?? '').trim()
  if (!raw) throw new Error('Missing sender.')
  if (raw.length > MAX_SENDER_LEN) throw new Error('Sender too long.')
  if (!SENDER_RE.test(raw)) throw new Error('Invalid sender.')
  // Normalize so reads/checks key on the same string the server stored.
  return normalizeAddress(raw)
}

function parseSince(v: string | null): number {
  if (v == null || v === '') return DEFAULT_SINCE_MIN
  const n = parseInt(v, 10)
  if (Number.isNaN(n) || n <= 0) throw new Error('Invalid since (minutes).')
  return Math.min(n, MAX_SINCE_MIN)
}

/**
 * Validate a display name. `allowEmpty` lets /resolve treat a missing/blank
 * name as "return the whole address book" rather than an error.
 */
function parseName(v: string | null | undefined, allowEmpty = false): string {
  const n = (v ?? '').trim()
  if (!n) {
    if (allowEmpty) return ''
    throw new Error('Missing name.')
  }
  if (n.length > MAX_NAME_LEN) throw new Error('Name too long.')
  if (NAME_CTRL_RE.test(n)) throw new Error('Invalid name.')
  return n
}

function parseRecipient(v: string | null): string {
  const raw = (v ?? '').trim()
  if (!raw) throw new Error('Missing recipient.')
  if (raw.length > MAX_SENDER_LEN) throw new Error('Recipient too long.')
  if (!SENDER_RE.test(raw)) throw new Error('Invalid recipient.')
  return validateRecipientAddress(raw)
}

function parseText(v: string | null | undefined): string {
  const t = String(v ?? '')
  if (!t.trim()) throw new Error('Missing text.')
  if (t.length > MAX_MESSAGE_LEN) throw new Error('Text too long.')
  if (TEXT_CTRL_RE.test(t)) throw new Error('Invalid text.')
  return t
}

/** Read a request body with a hard size cap (fails closed on overflow). */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        reject(new Error('Body too large.'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** List inbound senders with approval status and display labels (no message text). */
async function handleListNew(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const since = parseSince(url.searchParams.get('since'))
  const { adapter, ctx, error } = resolveReadableAdapter(channel, cfg)
  if (!adapter || !ctx) return { status: 501, body: { error } }
  let senders
  try {
    senders = await adapter.listInboundSenders(ctx, since)
  } catch (e) {
    return { status: 502, body: { error: String(e instanceof Error ? e.message : e) } }
  }
  // One list fetch -> address->label map (best-effort; null on any failure).
  const labels = await buildLabelMap(cfg, channel)
  // Build the Contacts index ONCE per request (best-effort, empty on failure).
  const contacts = contactIndexForRequest()
  const results = []
  for (const s of senders) {
    let status: CheckStatus = 'unknown'
    let checkError: string | undefined
    try {
      status = await checkSenderCached(cfg, channel, s.sender)
    } catch (e) {
      checkError = String(e instanceof Error ? e.message : e)
    }
    const entry: Record<string, unknown> = {
      sender: s.sender,
      message_count: s.message_count,
      latest_at: s.latest_at,
      status,
      // `label` = user's snazi.dev account-set name (privileged display).
      label: labels.get(normalizeAddress(s.sender)) ?? null,
      // `contact_name` = local macOS Contacts name (display-only metadata).
      // Kept SEPARATE from `label`; included regardless of approval status.
      // It NEVER affects `status` or the read gate.
      contact_name: contacts.get(s.sender),
    }
    if (checkError) entry.error = checkError
    results.push(entry)
  }
  return { status: 200, body: { channel, since_minutes: since, senders: results } }
}

async function handleRead(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const sender = parseSender(url.searchParams.get('sender'))
  const channel = parseChannel(url.searchParams.get('channel'))
  const since = parseSince(url.searchParams.get('since'))

  // Resolve the local source first so an unsupported channel/platform fails
  // clearly (and we never touch the network or any message text).
  const { adapter, ctx, error } = resolveReadableAdapter(channel, cfg)
  if (!adapter || !ctx) return { status: 501, body: { error } }

  // GATE: check approval BEFORE touching any message text.
  let status: string
  try {
    status = await checkSenderCached(cfg, channel, sender)
  } catch (e) {
    return {
      status: 502,
      body: { error: `Approval check failed: ${String(e instanceof Error ? e.message : e)}` },
    }
  }
  if (status !== 'approved') {
    // GATE: reading is denied SOLELY on approval status. `contact_name` is
    // deliberately NOT consulted here — a known Contacts name must never open
    // the gate. We don't even compute it on the denied path.
    return {
      status: 403,
      body: { error: 'Sender not approved. No messages for you.', status },
    }
  }
  let messages
  try {
    messages = await adapter.readMessagesFrom(ctx, sender, since)
  } catch (e) {
    return { status: 502, body: { error: String(e instanceof Error ? e.message : e) } }
  }
  // Gate already passed; attach display-only Contacts name (best-effort).
  const contact_name = contactIndexForRequest().get(sender)
  return {
    status: 200,
    body: { sender, channel, status, since_minutes: since, contact_name, messages },
  }
}

async function handleCheck(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const sender = parseSender(url.searchParams.get('sender'))
  const channel = parseChannel(url.searchParams.get('channel'))
  let status: string
  try {
    status = await checkSenderCached(cfg, channel, sender)
  } catch (e) {
    return {
      status: 502,
      body: { error: `Approval check failed: ${String(e instanceof Error ? e.message : e)}` },
    }
  }
  // Best-effort label lookup for this one address (display only).
  const labels = await buildLabelMap(cfg, channel)
  const label = labels.get(sender) ?? null
  // Display-only Contacts name. Kept separate from `label`; included no matter
  // the approval status. It does NOT (and must not) affect `status`.
  const contact_name = contactIndexForRequest().get(sender)
  return { status: 200, body: { channel, sender, status, label, contact_name } }
}

/**
 * GET /resolve?name=<q>&channel=<id>
 * Name->address "address book" lookup. Match = case-insensitive substring of a
 * sender's label against the query. Empty/omitted name -> every sender that has
 * a non-null label. Reveals only address+label+status (same sensitivity as
 * /list-new) — never message text.
 */
async function handleResolve(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const query = parseName(url.searchParams.get('name'), true)
  const needle = query.toLowerCase()
  const senders = await listSenders(cfg, channel)
  // Build the Contacts index ONCE for this request (best-effort, empty on fail).
  const contacts = contactIndexForRequest()
  const matches = senders
    .filter((s: SenderRecord) => {
      if (s.label == null || s.label === '') return false
      if (needle === '') return true // whole address book
      return s.label.toLowerCase().includes(needle)
    })
    .map((s: SenderRecord) => ({
      sender_address: s.sender_address,
      label: s.label,
      status: s.status,
      // Display-only macOS Contacts name; separate from `label`, never gates.
      contact_name: contacts.get(s.sender_address),
    }))
  return { status: 200, body: { channel, query, matches } }
}

/**
 * POST /label  body: { sender, channel, name }
 * Sets a sender's display label via the UPDATE-only web endpoint. This is the
 * ONLY write this read-only gate can make. It is structurally incapable of
 * creating a row or changing `status`, so it CANNOT open the gate — a label is
 * non-privileged display metadata. Reading is always re-gated by status per
 * address, so a wrong/forged label can never reveal message text.
 */
async function handleLabel(
  cfg: Config,
  rawBody: string
): Promise<{ status: number; body: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } }
  }
  const b = (parsed ?? {}) as { sender?: unknown; channel?: unknown; name?: unknown }
  const sender = parseSender(typeof b.sender === 'string' ? b.sender : null)
  const channel = parseChannel(typeof b.channel === 'string' ? b.channel : null)
  const name = parseName(typeof b.name === 'string' ? b.name : null)
  try {
    const result = await setLabel(cfg, channel, sender, name)
    return { status: 200, body: { ok: true, channel, sender, label: name, result } }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    // Surface the web 404 (sender not on the list) as a 404 to the caller.
    const code = /HTTP 404/.test(msg) ? 404 : 502
    return { status: code, body: { error: `Label failed: ${msg}` } }
  }
}

/**
 * POST /send  body: { recipient, channel, text }
 * Sends an outbound message. NEVER gated by the approval list — the soup nazi
 * only blocks reading.
 */
async function handleSend(
  cfg: Config,
  rawBody: string
): Promise<{ status: number; body: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } }
  }
  const b = (parsed ?? {}) as { recipient?: unknown; channel?: unknown; text?: unknown }
  const recipient = parseRecipient(typeof b.recipient === 'string' ? b.recipient : null)
  const channel = parseChannel(typeof b.channel === 'string' ? b.channel : null)
  const text = parseText(typeof b.text === 'string' ? b.text : null)
  const { adapter, ctx, error } = resolveSendableAdapter(channel, cfg)
  if (!adapter?.sendMessage || !ctx) {
    return { status: 501, body: { error } }
  }
  try {
    await adapter.sendMessage(ctx, recipient, text)
    return { status: 200, body: { ok: true, channel, recipient } }
  } catch (e) {
    return {
      status: 502,
      body: { error: String(e instanceof Error ? e.message : e) },
    }
  }
}

const VALID_ACTIONS = new Set(['archive', 'delete', 'markRead', 'markUnread'])

/** Parse + validate an action id from a request body. */
function parseAction(v: unknown): 'archive' | 'delete' | 'markRead' | 'markUnread' {
  const a = typeof v === 'string' ? v.trim() : ''
  if (!VALID_ACTIONS.has(a)) {
    throw new Error('Invalid action. Use archive | delete | markRead | markUnread.')
  }
  return a as 'archive' | 'delete' | 'markRead' | 'markUnread'
}

/** Parse an optional adapter-native message id. */
function parseMessageId(v: unknown): string | undefined {
  if (v == null) return undefined
  const raw = String(v).trim()
  if (!raw) return undefined
  if (raw.length > 512) throw new Error('messageId too long.')
  if (TEXT_CTRL_RE.test(raw)) throw new Error('Invalid messageId.')
  return raw
}

const VALID_FILTER_ACTIONS = new Set(['delete', 'archive', 'label', 'markRead', 'forward'])
const MAX_FILTER_FIELD_LEN = 512

/** Parse a required adapter-native filter/rule id (Gmail filter / Graph rule). */
function parseFilterId(v: string | null | undefined): string {
  const raw = (v ?? '').trim()
  if (!raw) throw new Error('Missing id.')
  if (raw.length > MAX_FILTER_FIELD_LEN) throw new Error('id too long.')
  if (TEXT_CTRL_RE.test(raw)) throw new Error('Invalid id.')
  return raw
}

/** Parse an optional short filter string field (from/subject/label/etc). */
function parseFilterField(v: unknown, name: string): string | undefined {
  if (v == null) return undefined
  const raw = String(v).trim()
  if (!raw) return undefined
  if (raw.length > MAX_FILTER_FIELD_LEN) throw new Error(`${name} too long.`)
  if (TEXT_CTRL_RE.test(raw)) throw new Error(`Invalid ${name}.`)
  return raw
}

function parseFilterAction(v: unknown): FilterSpec['action'] | undefined {
  if (v == null || v === '') return undefined
  const a = String(v).trim()
  if (!VALID_FILTER_ACTIONS.has(a)) {
    throw new Error('Invalid action. Use delete | archive | label | markRead | forward.')
  }
  return a as FilterSpec['action']
}

/** Only accept a plain JSON object for raw criteria/actions passthrough. */
function parseRawObject(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`Invalid ${name}: expected a JSON object.`)
  }
  return v as Record<string, unknown>
}

/** Build a validated FilterSpec from a parsed request body. */
function parseFilterSpec(b: Record<string, unknown>): FilterSpec {
  const spec: FilterSpec = {}
  const from = parseFilterField(b.from, 'from')
  const to = parseFilterField(b.to, 'to')
  const subject = parseFilterField(b.subject, 'subject')
  const query = parseFilterField(b.query, 'query')
  const labelId = parseFilterField(b.labelId, 'labelId')
  const forwardTo = parseFilterField(b.forwardTo, 'forwardTo')
  const folderId = parseFilterField(b.folderId, 'folderId')
  const name = parseFilterField(b.name, 'name')
  const action = parseFilterAction(b.action)
  const criteria = parseRawObject(b.criteria, 'criteria')
  const actions = parseRawObject(b.actions, 'actions')
  if (from) spec.from = from
  if (to) spec.to = to
  if (subject) spec.subject = subject
  if (query) spec.query = query
  if (labelId) spec.labelId = labelId
  if (forwardTo) spec.forwardTo = forwardTo
  if (folderId) spec.folderId = folderId
  if (name) spec.name = name
  if (action) spec.action = action
  if (criteria) spec.criteria = criteria
  if (actions) spec.actions = actions
  return spec
}

/**
 * POST /filter/create  body: { channel, from?, to?, subject?, query?, action?,
 *   labelId?, forwardTo?, folderId?, name?, criteria?, actions? }
 * Creates a Gmail filter / Outlook rule. NEVER gated by the approval list.
 */
async function handleFilterCreate(
  cfg: Config,
  rawBody: string
): Promise<{ status: number; body: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } }
  }
  const b = (parsed ?? {}) as Record<string, unknown>
  const channel = parseChannel(typeof b.channel === 'string' ? b.channel : null)
  const spec = parseFilterSpec(b)
  const { adapter, ctx, error } = resolveFilterAdapter(channel, cfg)
  if (!adapter?.createFilter || !ctx) return { status: 501, body: { error } }
  try {
    const filter = await adapter.createFilter(ctx, spec)
    return { status: 200, body: { ok: true, channel, filter } }
  } catch (e) {
    return { status: 502, body: { error: String(e instanceof Error ? e.message : e) } }
  }
}

/** GET /filter/list?channel=... — list all filters/rules. */
async function handleFilterList(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const { adapter, ctx, error } = resolveFilterAdapter(channel, cfg)
  if (!adapter?.listFilters || !ctx) return { status: 501, body: { error } }
  try {
    const filters = await adapter.listFilters(ctx)
    return { status: 200, body: { channel, count: filters.length, filters } }
  } catch (e) {
    return { status: 502, body: { error: String(e instanceof Error ? e.message : e) } }
  }
}

/** GET /filter/get?channel=...&id=... — one filter/rule by id. */
async function handleFilterGet(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const id = parseFilterId(url.searchParams.get('id'))
  const { adapter, ctx, error } = resolveFilterAdapter(channel, cfg)
  if (!adapter?.getFilter || !ctx) return { status: 501, body: { error } }
  try {
    const filter = await adapter.getFilter(ctx, id)
    return { status: 200, body: { channel, filter } }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    const code = /HTTP 404/.test(msg) ? 404 : 502
    return { status: code, body: { error: msg } }
  }
}

/** PATCH /filter/update?channel=...&id=... — Outlook only; Gmail returns 405. */
async function handleFilterUpdate(
  cfg: Config,
  url: URL,
  rawBody: string
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const id = parseFilterId(url.searchParams.get('id'))
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } }
  }
  const spec = parseFilterSpec((parsed ?? {}) as Record<string, unknown>)
  const { adapter, ctx, error } = resolveFilterAdapter(channel, cfg)
  if (!adapter || !ctx) return { status: 501, body: { error } }
  if (!adapter.updateFilter) {
    return {
      status: 405,
      body: {
        error: `Channel '${channel}' has no update API. Delete and recreate the filter instead.`,
      },
    }
  }
  try {
    const filter = await adapter.updateFilter(ctx, id, spec)
    return { status: 200, body: { ok: true, channel, filter } }
  } catch (e) {
    return { status: 502, body: { error: String(e instanceof Error ? e.message : e) } }
  }
}

/** DELETE /filter/delete?channel=...&id=... — remove a filter/rule. */
async function handleFilterDelete(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const id = parseFilterId(url.searchParams.get('id'))
  const { adapter, ctx, error } = resolveFilterAdapter(channel, cfg)
  if (!adapter?.deleteFilter || !ctx) return { status: 501, body: { error } }
  try {
    await adapter.deleteFilter(ctx, id)
    return { status: 200, body: { ok: true, channel, id, deleted: true } }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    const code = /HTTP 404/.test(msg) ? 404 : 502
    return { status: code, body: { error: msg } }
  }
}

/**
 * POST /action  body: { sender?, messageId?, channel, action, sinceMinutes? }
 * Performs an action (archive/delete/markRead/markUnread) on one or more
 * messages. NEVER gated by the approval list — the soup nazi only blocks
 * reading. Requires either `sender` or `messageId` to target messages.
 */
async function handleAction(
  cfg: Config,
  rawBody: string
): Promise<{ status: number; body: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody || '{}')
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body.' } }
  }
  const b = (parsed ?? {}) as {
    sender?: unknown
    messageId?: unknown
    channel?: unknown
    action?: unknown
    sinceMinutes?: unknown
  }
  const channel = parseChannel(typeof b.channel === 'string' ? b.channel : null)
  const action = parseAction(b.action)
  const messageId = parseMessageId(b.messageId)
  // Sender is optional (sender XOR messageId targeting). When present, validate
  // it the same way as elsewhere; when absent, require a messageId.
  const sender =
    typeof b.sender === 'string' && b.sender.trim()
      ? parseSender(b.sender)
      : undefined
  if (!sender && !messageId) {
    return { status: 400, body: { error: 'Provide either sender or messageId.' } }
  }
  const sinceMinutes =
    b.sinceMinutes == null || b.sinceMinutes === ''
      ? undefined
      : parseSince(String(b.sinceMinutes))

  const { adapter, ctx, error } = resolveActionableAdapter(channel, cfg)
  if (!adapter?.performMessageAction || !ctx) {
    return { status: 501, body: { error } }
  }
  try {
    const { affected } = await adapter.performMessageAction(ctx, action, {
      sender,
      messageId,
      sinceMinutes,
    })
    return { status: 200, body: { ok: true, channel, action, affected } }
  } catch (e) {
    return {
      status: 502,
      body: { error: String(e instanceof Error ? e.message : e) },
    }
  }
}

/** Build (but do not start) the HTTP server. Exposed for tests. */
export function createServer(cfg: Config): http.Server {
  const token = cfg.serveToken ?? ''
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET'
        // Parse against a dummy base; we only use pathname + searchParams.
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname.replace(/\/+$/, '') || '/'

        // /health is unauthenticated (connectivity probe only — no data).
        // GET only — no body, no data.
        if (method === 'GET' && pathname === '/health') {
          return sendJson(res, 200, { ok: true, version: VERSION })
        }

        // Allowed verbs on this surface: GET (reads), POST (label/send/action/
        // filter create), PATCH (filter update), DELETE (filter delete).
        if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
          return sendJson(res, 405, { error: 'Method not allowed.' })
        }

        // Everything past /health requires a valid bearer token — including writes.
        if (!bearerOk(req.headers['authorization'], token)) {
          res.setHeader('www-authenticate', 'Bearer')
          return sendJson(res, 401, { error: 'Unauthorized.' })
        }

        if (method === 'POST') {
          const rawBody = await readBody(req, pathname === '/label' ? MAX_LABEL_BODY_BYTES : MAX_BODY_BYTES)
          if (pathname === '/label') {
            const r = await handleLabel(cfg, rawBody)
            return sendJson(res, r.status, r.body)
          }
          if (pathname === '/send') {
            const r = await handleSend(cfg, rawBody)
            return sendJson(res, r.status, r.body)
          }
          if (pathname === '/action') {
            const r = await handleAction(cfg, rawBody)
            return sendJson(res, r.status, r.body)
          }
          if (pathname === '/filter/create') {
            const r = await handleFilterCreate(cfg, rawBody)
            return sendJson(res, r.status, r.body)
          }
          return sendJson(res, 404, { error: 'Not found.' })
        }

        if (method === 'PATCH') {
          if (pathname === '/filter/update') {
            const rawBody = await readBody(req, MAX_BODY_BYTES)
            const r = await handleFilterUpdate(cfg, url, rawBody)
            return sendJson(res, r.status, r.body)
          }
          return sendJson(res, 404, { error: 'Not found.' })
        }

        if (method === 'DELETE') {
          if (pathname === '/filter/delete') {
            const r = await handleFilterDelete(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          return sendJson(res, 404, { error: 'Not found.' })
        }

        switch (pathname) {
          case '/list-new': {
            const r = await handleListNew(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          case '/read': {
            const r = await handleRead(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          case '/check': {
            const r = await handleCheck(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          case '/resolve': {
            const r = await handleResolve(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          case '/filter/list': {
            const r = await handleFilterList(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          case '/filter/get': {
            const r = await handleFilterGet(cfg, url)
            return sendJson(res, r.status, r.body)
          }
          default:
            return sendJson(res, 404, { error: 'Not found.' })
        }
      } catch (e) {
        // Validation/handler errors → 400 with a safe message (never the token).
        return sendJson(res, 400, {
          error: String(e instanceof Error ? e.message : e),
        })
      }
    })()
  })
}

/** Start `snazi serve`. Resolves when the server is listening. */
export async function startServer(
  cfg: Config,
  opts: ServeOptions
): Promise<{ bind: string; port: number; server: http.Server }> {
  if (!cfg.serveToken) {
    throw new Error(
      'serveToken not set in ~/.snazi/config.json. Add a strong random token ' +
        '(e.g. `openssl rand -hex 32`) before exposing the gate over HTTP.'
    )
  }
  const bind = resolveBind(cfg, opts)
  const port = resolvePort(cfg, opts)
  const server = createServer(cfg)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const onTailnet = bind.startsWith('100.') || bind === detectTailscaleIp()
  console.error(
    JSON.stringify({
      ok: true,
      msg: 'snazi serve listening (gated read + ungated send)',
      bind,
      port,
      version: VERSION,
      surface: [
        '/health',
        '/list-new',
        '/check',
        '/read',
        '/resolve',
        'POST /label',
        'POST /send',
        'POST /action',
        'POST /filter/create',
        'GET /filter/list',
        'GET /filter/get',
        'PATCH /filter/update',
        'DELETE /filter/delete',
      ],
      reachable_on:
        bind === '127.0.0.1'
          ? 'loopback only (front with `tailscale serve` for tailnet access)'
          : onTailnet
            ? 'tailnet only (100.x)'
            : `custom bind ${bind}`,
    })
  )
  return { bind, port, server }
}
