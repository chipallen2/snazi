/**
 * `snazi init` — create or update ~/.snazi/config.json without hand-editing JSON.
 *
 * Works two ways:
 *   - Interactive (a TTY): prompts for the deployment URL, the account READ
 *     token, and the channel(s), each pre-filled with a sensible default.
 *   - Non-interactive (agents/CI, or `--yes`): takes values from flags
 *     (--api-url, --token, --channel) and/or an existing config. Prompts are
 *     skipped; a missing token is a hard error with guidance.
 *
 * Existing config is treated as defaults and MERGED (serve/remote keys are
 * preserved), so re-running init never clobbers unrelated settings. Prompts are
 * written to stderr so stdout stays clean JSON for scripted callers.
 */
import * as readline from 'node:readline/promises'
import {
  type Config,
  type ChannelConfig,
  CONFIG_PATH,
  DEFAULT_API_URL,
  normalizeChannels,
  readConfigIfPresent,
  saveConfig,
} from './config'
import { ensureServeToken, serviceStart } from './service'
import { remoteHealth } from './client'

export interface InitArgs {
  apiUrl?: string
  token?: string
  channel?: string
  force?: boolean
  yes?: boolean
  /**
   * Set up the background serve gate (auto-start at login) as part of init.
   * `true` always sets it up (non-interactive provisioning); `undefined` means
   * "ask" in a TTY and "skip" otherwise.
   */
  serve?: boolean
}

/** Normalize a user-typed base URL: trim, drop trailing slash, default https. */
function normalizeUrl(input: string): string {
  let u = (input ?? '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  return u
}

/**
 * Like normalizeUrl but defaults to http:// — the messages machine is usually
 * reached over a private tailnet IP (e.g. http://100.x.y.z:8787), not HTTPS.
 */
function normalizeRemoteUrl(input: string): string {
  let u = (input ?? '').trim().replace(/\/+$/, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  return u
}

function maskToken(t: string): string {
  if (!t) return ''
  return `${t.slice(0, 6)}…(${t.length})`
}

export async function runInit(
  a: InitArgs
): Promise<{ code: number; result: unknown }> {
  const existing = readConfigIfPresent()
  const interactive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !a.yes
  const noFlags = !a.apiUrl && !a.token && !a.channel

  // Existing config + nothing to change + can't prompt -> no-op (don't clobber).
  // `--serve` counts as "something to do", so it still sets up the background gate.
  if (existing && !a.force && !interactive && noFlags && !a.serve) {
    return {
      code: 0,
      result: {
        ok: true,
        note: `Config already present at ${CONFIG_PATH}. Pass --force to rewrite, flags (--api-url/--token/--channel) to update, or run interactively.`,
        config_path: CONFIG_PATH,
      },
    }
  }

  let rl: readline.Interface | undefined
  if (interactive) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    })
  }
  const ask = async (q: string, def?: string): Promise<string> => {
    if (!rl) return def ?? ''
    const suffix = def ? ` [${def}]` : ''
    const ans = (await rl.question(`${q}${suffix}: `)).trim()
    return ans || def || ''
  }
  const askYesNo = async (q: string, def: boolean): Promise<boolean> => {
    if (!rl) return def
    const ans = (await rl.question(`${q}${def ? ' [Y/n]' : ' [y/N]'}: `)).trim().toLowerCase()
    if (!ans) return def
    return ans === 'y' || ans === 'yes'
  }

  try {
    const apiUrl = normalizeUrl(
      a.apiUrl ??
        (interactive
          ? await ask('Deployment URL', existing?.apiUrl ?? DEFAULT_API_URL)
          : existing?.apiUrl ?? DEFAULT_API_URL)
    )

    const token = (
      a.token ??
      (interactive
        ? await ask('Account READ token (from the dashboard Account page)', existing?.apiKey)
        : existing?.apiKey ?? '')
    ).trim()

    // Existing channels may be instance objects (with local credentials); keep
    // them so re-running init never wipes a configured gmail/outlook channel.
    const existingInstances = normalizeChannels(existing?.channels)
    const channelsDefault = existingInstances.length
      ? existingInstances.map((c) => c.id).join(',')
      : 'imessage'
    const channelsRaw = a.channel ?? (interactive ? await ask('Channel id(s), comma-separated', channelsDefault) : channelsDefault)
    const channelIds = channelsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ids = channelIds.length ? channelIds : ['imessage']
    // Reuse an existing instance (preserving its type + auth) when the id
    // matches; otherwise create a bare instance whose type equals its id.
    const channels: ChannelConfig[] = ids.map(
      (id) =>
        existingInstances.find((c) => c.id === id) ?? {
          id,
          type: id,
          name: id === 'imessage' ? 'iMessage' : id,
        }
    )

    if (!apiUrl) {
      return { code: 2, result: { error: 'A deployment URL is required.' } }
    }
    if (!token) {
      return {
        code: 2,
        result: {
          error:
            'A READ token is required. Pass --token <token> (or run interactively). ' +
            'Get it from your deployment dashboard → Account page.',
        },
      }
    }

    const merged: Config = {
      ...(existing ?? ({} as Config)),
      apiUrl,
      apiKey: token,
      channels,
    }
    saveConfig(merged)

    const warnings: string[] = []
    if (token.length < 16) {
      warnings.push(
        'That token looks short — double-check you copied the full READ token.'
      )
    }

    // Optional: set up the always-on background gate (serve mode) right here, so
    // people who run their AI on a separate AGENT MACHINE discover it without
    // hunting for a hidden flag. Only runs when explicitly requested (--serve)
    // or accepted at an interactive prompt — never silently under --yes/CI.
    let serve: Record<string, unknown> | undefined
    const wantServe =
      a.serve === true ||
      (interactive &&
        a.serve === undefined &&
        (await askYesNo(
          'Let an AI on a separate AGENT MACHINE reach this machine over your tailnet ' +
            '(run snazi in the background)? Most people can skip this',
          false
        )))
    if (wantServe) {
      const { token: serveToken, generated } = ensureServeToken(merged)
      const res = await serviceStart(merged, {})
      serve = { ...res.result }
      if (generated) serve.serveToken = serveToken
    }

    const next_steps = [
      'snazi doctor   # verify config, connectivity, and channel access',
      'snazi list-new --since 120',
    ]
    if (serve) {
      next_steps.push(
        '# On your AGENT MACHINE, run: snazi init-agent  (use the connect token printed above)'
      )
    } else {
      next_steps.push(
        '# Running your AI on a separate AGENT MACHINE? Start the background gate here:',
        'snazi start    # installs + starts the gate, auto-starts at login (snazi stop/restart too)',
        '#   then run `snazi init-agent` on the agent machine.'
      )
    }

    return {
      code: 0,
      result: {
        ok: true,
        role: 'messages machine',
        config_path: CONFIG_PATH,
        apiUrl,
        apiKey: maskToken(token),
        channels: channels.map((c) => c.id),
        warnings: warnings.length ? warnings : undefined,
        serve,
        next_steps,
      },
    }
  } finally {
    rl?.close()
  }
}

export interface InitAgentArgs {
  /** Base URL of the messages machine's gate (its remoteUrl), e.g. http://100.x.y.z:8787. */
  url?: string
  /** Connect token (the messages machine's serveToken). */
  token?: string
  /**
   * READ token (apiKey) so the agent can mint one-tap `/decide` approve links
   * itself — the main approval path, and the recommended setup. It's read-only:
   * it can check the list and mint links, but can't read message content or
   * approve/deny, so it can't bypass the gate. If omitted, the agent still reads
   * approved messages but new senders must be approved by hand in the dashboard.
   */
  readToken?: string
  /** Deployment URL for the READ token (defaults to snazi.dev). */
  apiUrl?: string
  yes?: boolean
}

/**
 * `snazi init-agent` — configure THIS machine as an AGENT MACHINE: it runs your
 * AI and reaches a messages machine's gate over the network with the `remote-*`
 * commands. It writes `remoteUrl` + `remoteToken` plus a read-only READ token
 * (recommended) so the agent can mint one-tap approve links itself. No channel
 * credentials or message access ever live here, so a compromised agent still
 * can't bypass the gate. Existing keys are preserved (re-running never clobbers
 * other settings).
 */
export async function runInitAgent(
  a: InitAgentArgs
): Promise<{ code: number; result: unknown }> {
  const existing = readConfigIfPresent()
  const interactive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !a.yes

  let rl: readline.Interface | undefined
  if (interactive) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    })
  }
  const ask = async (q: string, def?: string): Promise<string> => {
    if (!rl) return def ?? ''
    const suffix = def ? ` [${def}]` : ''
    const ans = (await rl.question(`${q}${suffix}: `)).trim()
    return ans || def || ''
  }

  try {
    const remoteUrl = normalizeRemoteUrl(
      a.url ??
        (interactive
          ? await ask(
              "Messages machine URL (printed by 'snazi start', e.g. http://100.x.y.z:8787)",
              existing?.remoteUrl
            )
          : existing?.remoteUrl ?? '')
    )
    const remoteToken = (
      a.token ??
      (interactive
        ? await ask(
            "Connect token (the serveToken 'snazi start' printed on the messages machine)",
            existing?.remoteToken
          )
        : existing?.remoteToken ?? '')
    ).trim()

    if (!remoteUrl) {
      return {
        code: 2,
        result: {
          error:
            'A messages machine URL is required. Pass --url <url> (or run interactively). ' +
            "It's the address 'snazi start' printed on the machine with your messages.",
        },
      }
    }
    if (!remoteToken) {
      return {
        code: 2,
        result: {
          error:
            'A connect token is required. Pass --token <token> (or run interactively). ' +
            "Run 'snazi start' on the messages machine to mint one (it's that machine's serveToken).",
        },
      }
    }

    // READ token so the agent can mint one-tap approve links itself (the main
    // approval path — recommended). Read-only, so it can't bypass the gate. A
    // blank answer keeps any existing token; we never echo the secret as a default.
    const readAns = a.readToken
      ? a.readToken
      : interactive
        ? await ask(
            'READ token (recommended) — lets your agent text you one-tap approve links. ' +
              'From snazi.dev → Account (leave blank only if you prefer approving in the dashboard)'
          )
        : ''
    const apiKey = (readAns || existing?.apiKey || '').trim()
    const apiUrl = apiKey
      ? normalizeUrl(a.apiUrl ?? existing?.apiUrl ?? DEFAULT_API_URL)
      : existing?.apiUrl

    // Preserve any existing keys; write the agent-side remote keys and, when
    // provided, the read-only READ token. The cast lets an agent config omit
    // apiUrl/apiKey (saveConfig just serializes; the messages-side loadConfig
    // still enforces them when needed).
    const merged = {
      ...(existing ?? {}),
      remoteUrl,
      remoteToken,
      ...(apiUrl ? { apiUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    } as Config
    saveConfig(merged)

    // Probe the messages machine so the user immediately knows it's reachable.
    let health: Record<string, unknown>
    try {
      const { status, json } = await remoteHealth(merged)
      health = { reachable: status >= 200 && status < 400, status, body: json }
    } catch (e) {
      health = {
        reachable: false,
        error: String(e instanceof Error ? e.message : e),
      }
    }

    const next_steps = [
      'snazi remote-status                 # confirm the messages machine is reachable',
      'snazi remote-list-new --since 120   # WHO messaged (no text)',
    ]
    next_steps.push(
      apiKey
        ? '# Unknown sender? Your agent can mint a one-tap approve link and text it to you.'
        : '# Approve unknown senders in the dashboard at snazi.dev (or re-run with --read-token to mint links here).'
    )
    if (!health.reachable) {
      next_steps.unshift(
        "# Can't reach the messages machine yet — check it's on the same tailnet and `snazi start` is running there."
      )
    }

    return {
      code: 0,
      result: {
        ok: true,
        role: 'agent machine',
        config_path: CONFIG_PATH,
        remoteUrl,
        remoteToken: maskToken(remoteToken),
        approve_links: apiKey ? 'enabled (agent can mint links)' : 'dashboard only',
        ...(apiKey ? { apiUrl, apiKey: maskToken(apiKey) } : {}),
        health,
        next_steps,
      },
    }
  } finally {
    rl?.close()
  }
}
