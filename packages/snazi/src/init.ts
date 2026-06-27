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
    // people who need a remote agent to reach this machine discover it without
    // hunting for a hidden flag. Only runs when explicitly requested (--serve)
    // or accepted at an interactive prompt — never silently under --yes/CI.
    let serve: Record<string, unknown> | undefined
    const wantServe =
      a.serve === true ||
      (interactive &&
        a.serve === undefined &&
        (await askYesNo(
          'Run snazi in the background so an agent on ANOTHER computer can reach ' +
            "this machine's messages (serve mode)? Most people can skip this",
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
    if (!serve) {
      next_steps.push(
        '# Need an agent on ANOTHER computer to reach this one? Run it in the background:',
        'snazi start    # installs + starts the gate, auto-starts at login (snazi stop/restart too)'
      )
    }

    return {
      code: 0,
      result: {
        ok: true,
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
