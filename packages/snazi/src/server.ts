/**
 * snazi serve — least-privilege HTTP gate.
 *
 *   "No messages for you."
 *
 * Exposes ONLY the read-only gated message operations over HTTP so a REMOTE
 * trusted agent (reachable only over a private Tailscale tailnet) can use them
 * without an SSH shell. This is deliberately a tiny, read-only surface:
 *
 *   GET /health                      -> { ok, version }            (no auth)
 *   GET /list-new?channel&since      -> WHO + status (never text)   (bearer)
 *   GET /read?sender&channel&since   -> text ONLY if approved       (bearer)
 *   GET /check?sender&channel        -> { status }                  (bearer)
 *
 * It REUSES the same gate (api.ts) and the same DB reader (chatdb.ts) as the
 * CLI. There is no approve/deny here — mutations stay CLI/dashboard-only. There
 * is no shell, no arbitrary file access, no path that bypasses the gate.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as os from 'os'
import type { Config } from './config'
import { checkSender } from './api'
import { listInboundSenders, readMessagesFrom } from './chatdb'

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
const CHANNEL_RE = /^[a-z0-9_-]+$/i
// iMessage senders are phone numbers (+1555…) or emails. Keep it tight.
const SENDER_RE = /^[A-Za-z0-9_.+@-]+$/

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
  const s = (v ?? '').trim()
  if (!s) throw new Error('Missing sender.')
  if (s.length > MAX_SENDER_LEN) throw new Error('Sender too long.')
  if (!SENDER_RE.test(s)) throw new Error('Invalid sender.')
  return s
}

function parseSince(v: string | null): number {
  if (v == null || v === '') return DEFAULT_SINCE_MIN
  const n = parseInt(v, 10)
  if (Number.isNaN(n) || n <= 0) throw new Error('Invalid since (minutes).')
  return Math.min(n, MAX_SINCE_MIN)
}

async function handleListNew(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const channel = parseChannel(url.searchParams.get('channel'))
  const since = parseSince(url.searchParams.get('since'))
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
  return { status: 200, body: { channel, since_minutes: since, senders: results } }
}

async function handleRead(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const sender = parseSender(url.searchParams.get('sender'))
  const channel = parseChannel(url.searchParams.get('channel'))
  const since = parseSince(url.searchParams.get('since'))

  // GATE: check approval BEFORE touching any message text.
  let status: string
  try {
    status = await checkSender(cfg, channel, sender)
  } catch (e) {
    return {
      status: 502,
      body: { error: `Approval check failed: ${String(e instanceof Error ? e.message : e)}` },
    }
  }
  if (status !== 'approved') {
    return {
      status: 403,
      body: { error: 'Sender not approved. No messages for you.', status },
    }
  }
  const messages = readMessagesFrom(sender, since)
  return {
    status: 200,
    body: { sender, channel, status, since_minutes: since, messages },
  }
}

async function handleCheck(
  cfg: Config,
  url: URL
): Promise<{ status: number; body: unknown }> {
  const sender = parseSender(url.searchParams.get('sender'))
  const channel = parseChannel(url.searchParams.get('channel'))
  const status = await checkSender(cfg, channel, sender)
  return { status: 200, body: { channel, sender, status } }
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

        if (method !== 'GET') {
          return sendJson(res, 405, { error: 'Method not allowed. Read-only.' })
        }

        // /health is unauthenticated (connectivity probe only — no data).
        if (pathname === '/health') {
          return sendJson(res, 200, { ok: true, version: VERSION })
        }

        // Everything else requires a valid bearer token.
        if (!bearerOk(req.headers['authorization'], token)) {
          res.setHeader('www-authenticate', 'Bearer')
          return sendJson(res, 401, { error: 'Unauthorized.' })
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
      msg: 'snazi serve listening (read-only gate)',
      bind,
      port,
      version: VERSION,
      surface: ['/health', '/list-new', '/check', '/read'],
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
