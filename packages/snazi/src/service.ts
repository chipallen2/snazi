/**
 * snazi background service — one friendly wrapper over each OS's service manager.
 *
 *   snazi start    -> install + run the serve gate in the background (auto-start)
 *   snazi stop     -> stop it and remove the auto-start entry
 *   snazi restart  -> stop then start (picks up config/bind changes)
 *
 * The point is to hide the platform plumbing. Under the hood:
 *   - macOS   -> launchd LaunchAgent  (launchctl load/unload)
 *   - Linux   -> systemd --user unit  (systemctl --user enable/disable --now)
 *   - Windows -> Task Scheduler task  (schtasks, launched hidden via wscript)
 *
 * Each manager owns auto-start-at-login. macOS/Linux also keep the process
 * alive if it crashes. On every platform `start` is idempotent (it re-applies
 * the definition and (re)starts), and after starting we poll the local
 * `/health` endpoint so the command can report whether the gate actually came
 * up — not just whether the manager accepted the job.
 *
 * The serve process itself stays exactly the same least-privilege HTTP gate as
 * `snazi serve`; this module only manages its lifecycle.
 */
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { CONFIG_DIR, saveConfig, type Config } from './config'
import { installDaemon, LABEL } from './daemon'
import { DEFAULT_PORT, resolveBind } from './server'

/** PID file written by a running `snazi serve` so Windows `stop` can find it. */
export const PID_PATH = path.join(CONFIG_DIR, 'serve.pid')
/** Windows Scheduled Task name. */
export const WIN_TASK_NAME = 'snazi-serve'
/** systemd --user unit name. */
export const SYSTEMD_UNIT = 'snazi.service'

export interface ServiceOptions {
  bind?: string
  port?: number
}

export interface ServiceResult {
  code: number
  result: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// PID file (used by Windows stop; harmless elsewhere).
// ---------------------------------------------------------------------------

/** Record the running serve PID. Best-effort; never throws. */
export function writeServePid(pid: number = process.pid): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(PID_PATH, String(pid), { mode: 0o600 })
  } catch {
    // best-effort only
  }
}

/** Remove the serve PID file on clean shutdown. Best-effort; never throws. */
export function clearServePid(): void {
  try {
    fs.unlinkSync(PID_PATH)
  } catch {
    // already gone / unreadable — fine
  }
}

/** Read the recorded serve PID, or null if absent/invalid. */
export function readServePid(): number | null {
  try {
    const n = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// serveToken — generate one on first `start` so the user never has to.
// ---------------------------------------------------------------------------

/**
 * Ensure the config has a serveToken (every protected serve endpoint needs it).
 * If missing, mint a strong random one and persist it. Returns whether it was
 * just generated so the caller can surface it (the agent host needs the same
 * value as its `remoteToken`).
 */
export function ensureServeToken(cfg: Config): { token: string; generated: boolean } {
  if (cfg.serveToken && cfg.serveToken.trim()) {
    return { token: cfg.serveToken, generated: false }
  }
  const token = crypto.randomBytes(32).toString('hex')
  cfg.serveToken = token
  saveConfig(cfg)
  return { token, generated: true }
}

// ---------------------------------------------------------------------------
// Small process / path helpers.
// ---------------------------------------------------------------------------

interface RunResult {
  ran: boolean
  code: number
  stdout: string
  stderr: string
}

/** Run a command synchronously, capturing output. Never throws. */
function run(cmd: string, args: string[]): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (r.error) {
    return { ran: false, code: 1, stdout: '', stderr: String(r.error.message || r.error) }
  }
  return { ran: true, code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Absolute path to the compiled CLI (dist/cli.js), next to this module. */
function cliPath(): string {
  const cli = path.join(__dirname, 'cli.js')
  if (!fs.existsSync(cli)) {
    throw new Error(`Cannot find compiled CLI at ${cli}. Run 'npm run build' first.`)
  }
  return cli
}

/** Mirror server.ts port policy without importing its private resolver. */
function resolvePort(cfg: Config, port?: number): number {
  const p = port ?? cfg.servePort ?? DEFAULT_PORT
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`Invalid port: ${p}`)
  }
  return p
}

function managerName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'launchd'
    case 'linux':
      return 'systemd (--user)'
    case 'win32':
      return 'Windows Task Scheduler'
    default:
      return 'none'
  }
}

// ---------------------------------------------------------------------------
// Health probe — confirm the gate actually answers after we (re)start it.
// ---------------------------------------------------------------------------

function probeHealth(
  bind: string,
  port: number,
  timeoutMs = 800
): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    // The bound IP (tailnet 100.x or 127.0.0.1) is a local interface, so we can
    // always reach it from this host. '*'/0.0.0.0 are refused at bind time.
    const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as { ok?: boolean; version?: string }
          resolve({ ok: res.statusCode === 200 && j.ok === true, version: j.version })
        } catch {
          resolve({ ok: false })
        }
      })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false })
    })
  })
}

/** Poll /health for a few seconds so `start` can report real readiness. */
async function waitForHealth(
  bind: string,
  port: number,
  totalMs = 4000
): Promise<{ ok: boolean; version?: string }> {
  const deadline = Date.now() + totalMs
  let last: { ok: boolean; version?: string } = { ok: false }
  while (Date.now() < deadline) {
    last = await probeHealth(bind, port)
    if (last.ok) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  return last
}

// ---------------------------------------------------------------------------
// Service-definition renderers (pure; exported for tests).
// ---------------------------------------------------------------------------

/** A systemd --user unit that runs `snazi serve` and restarts on failure. */
export function renderSystemdUnit(node: string, cli: string, bind: string, port: number): string {
  return `[Unit]
Description=snazi serve — least-privilege message gate
Documentation=https://snazi.dev
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${cli} serve --bind ${bind} --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/**
 * A VBScript launcher that starts `snazi serve` with NO visible window
 * (WScript.Shell.Run mode 0, async). On Windows this is the only reliable way
 * to run a console program fully hidden. Doubled double-quotes ("") embed a
 * literal quote so paths containing spaces survive.
 */
export function renderVbsLauncher(node: string, cli: string, bind: string, port: number): string {
  const command = `""${node}"" ""${cli}"" serve --bind ${bind} --port ${port}`
  return [
    `' snazi serve — hidden background launcher (generated by 'snazi start')`,
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.Run "${command}", 0, False`,
    ``,
  ].join('\r\n')
}

/**
 * A Task Scheduler definition (XML) that runs the hidden VBS launcher at logon
 * with least privilege. Using /XML avoids all of schtasks' nested-quote pain.
 */
export function renderTaskXml(vbsFullPath: string): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const args = `//B //Nologo "${vbsFullPath}"`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>snazi serve — least-privilege message gate</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${esc(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

// ---------------------------------------------------------------------------
// Path helpers per platform.
// ---------------------------------------------------------------------------

function darwinPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'systemd', 'user', SYSTEMD_UNIT)
}

function systemdAvailable(): boolean {
  const r = run('systemctl', ['--user', '--version'])
  return r.ran && r.code === 0
}

function winVbsPath(): string {
  return path.join(CONFIG_DIR, 'snazi-serve.vbs')
}

function winTaskXmlPath(): string {
  return path.join(CONFIG_DIR, 'snazi-serve.task.xml')
}

// ---------------------------------------------------------------------------
// macOS (launchd).
// ---------------------------------------------------------------------------

async function startDarwin(cfg: Config, opts: ServiceOptions): Promise<ServiceResult> {
  // installDaemon writes the LaunchAgent plist (resolving bind/port + node/cli).
  const d = installDaemon(cfg, { bind: opts.bind, port: opts.port })
  // Idempotent: drop any previously loaded copy (ignore "not loaded"), then load.
  run('launchctl', ['unload', '-w', d.plistPath])
  const load = run('launchctl', ['load', '-w', d.plistPath])
  const health = await waitForHealth(d.bind, d.port)

  const notes: string[] = [
    'Auto-starts at login and restarts if it crashes (launchd KeepAlive).',
    `To read iMessage, grant Full Disk Access to this node binary, then 'snazi restart': ${d.node}`,
    '  (System Settings > Privacy & Security > Full Disk Access)',
  ]
  if (load.code !== 0 && load.stderr.trim()) notes.push(`launchctl: ${load.stderr.trim()}`)
  if (!health.ok) {
    notes.push(
      `Gate isn't answering /health on ${d.bind}:${d.port} yet — check ~/Library/Logs/snazi-serve.err.log`
    )
  }

  return {
    code: load.code === 0 ? 0 : 1,
    result: {
      ok: load.code === 0,
      action: 'start',
      manager: 'launchd',
      label: LABEL,
      bind: d.bind,
      port: d.port,
      running: health.ok,
      version: health.version ?? null,
      plist: d.plistPath,
      node: d.node,
      notes,
    },
  }
}

function stopDarwin(): ServiceResult {
  const plistPath = darwinPlistPath()
  const existed = fs.existsSync(plistPath)
  const unload = run('launchctl', ['unload', '-w', plistPath])
  return {
    code: 0,
    result: {
      ok: true,
      action: 'stop',
      manager: 'launchd',
      label: LABEL,
      was_installed: existed,
      notes: [
        existed
          ? `Unloaded ${plistPath} (won't auto-start at login until 'snazi start').`
          : `No LaunchAgent at ${plistPath}; nothing to stop.`,
        ...(unload.code !== 0 && unload.stderr.trim() ? [`launchctl: ${unload.stderr.trim()}`] : []),
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Linux (systemd --user).
// ---------------------------------------------------------------------------

async function startLinux(cfg: Config, opts: ServiceOptions): Promise<ServiceResult> {
  if (!systemdAvailable()) {
    return {
      code: 2,
      result: {
        ok: false,
        action: 'start',
        manager: 'none',
        error: 'systemd --user is not available on this host.',
        notes: ['Run `snazi serve` under your own supervisor (pm2, nohup, a system unit, etc.).'],
      },
    }
  }
  const node = process.execPath
  const cli = cliPath()
  const bind = resolveBind(cfg, { bind: opts.bind })
  const port = resolvePort(cfg, opts.port)
  const unitPath = systemdUnitPath()
  fs.mkdirSync(path.dirname(unitPath), { recursive: true })
  fs.writeFileSync(unitPath, renderSystemdUnit(node, cli, bind, port), { mode: 0o644 })

  run('systemctl', ['--user', 'daemon-reload'])
  const enable = run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
  const health = await waitForHealth(bind, port)

  const user = process.env.USER || '$USER'
  const notes: string[] = [
    'Auto-starts on login (systemd --user, Restart=on-failure).',
    `To keep it running without an active login session: loginctl enable-linger ${user}`,
  ]
  if (enable.code !== 0 && enable.stderr.trim()) notes.push(`systemctl: ${enable.stderr.trim()}`)
  if (!health.ok) {
    notes.push(`Gate isn't answering /health yet — check: journalctl --user -u ${SYSTEMD_UNIT} -e`)
  }

  return {
    code: enable.code === 0 ? 0 : 1,
    result: {
      ok: enable.code === 0,
      action: 'start',
      manager: 'systemd',
      unit: unitPath,
      bind,
      port,
      running: health.ok,
      version: health.version ?? null,
      notes,
    },
  }
}

function stopLinux(): ServiceResult {
  if (!systemdAvailable()) {
    return {
      code: 0,
      result: {
        ok: true,
        action: 'stop',
        manager: 'none',
        notes: ['systemd --user not available; nothing to stop.'],
      },
    }
  }
  const disable = run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
  return {
    code: 0,
    result: {
      ok: true,
      action: 'stop',
      manager: 'systemd',
      unit: SYSTEMD_UNIT,
      notes: [
        disable.code === 0
          ? `Stopped and disabled ${SYSTEMD_UNIT}.`
          : disable.stderr.trim() || 'Nothing to stop.',
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Windows (Task Scheduler + hidden wscript launcher + PID file).
// ---------------------------------------------------------------------------

async function startWindows(cfg: Config, opts: ServiceOptions): Promise<ServiceResult> {
  const node = process.execPath
  const cli = cliPath()
  const bind = resolveBind(cfg, { bind: opts.bind })
  const port = resolvePort(cfg, opts.port)

  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const vbs = winVbsPath()
  fs.writeFileSync(vbs, renderVbsLauncher(node, cli, bind, port))
  const xml = winTaskXmlPath()
  // schtasks /XML is most reliable with UTF-16 + BOM.
  fs.writeFileSync(xml, '\ufeff' + renderTaskXml(vbs), { encoding: 'utf16le' })

  const create = run('schtasks', ['/Create', '/TN', WIN_TASK_NAME, '/XML', xml, '/F'])
  // Start it now so the user doesn't have to log out/in first.
  const runNow = run('schtasks', ['/Run', '/TN', WIN_TASK_NAME])
  const health = await waitForHealth(bind, port)

  const notes: string[] = ['Auto-starts at logon (hidden Windows Scheduled Task).']
  if (create.code !== 0) {
    notes.push(`schtasks /Create: ${(create.stderr || create.stdout || 'failed').trim()}`)
  }
  if (runNow.code !== 0 && runNow.stderr.trim()) notes.push(`schtasks /Run: ${runNow.stderr.trim()}`)
  if (!health.ok) notes.push(`Gate isn't answering /health on ${bind}:${port} yet.`)

  return {
    code: create.code === 0 ? 0 : 1,
    result: {
      ok: create.code === 0,
      action: 'start',
      manager: 'schtasks',
      task: WIN_TASK_NAME,
      bind,
      port,
      running: health.ok,
      version: health.version ?? null,
      launcher: vbs,
      notes,
    },
  }
}

function stopWindows(): ServiceResult {
  const pid = readServePid()
  let killed = false
  if (pid) {
    const kill = run('taskkill', ['/PID', String(pid), '/T', '/F'])
    killed = kill.code === 0
  }
  run('schtasks', ['/End', '/TN', WIN_TASK_NAME])
  const del = run('schtasks', ['/Delete', '/TN', WIN_TASK_NAME, '/F'])
  clearServePid()
  return {
    code: 0,
    result: {
      ok: true,
      action: 'stop',
      manager: 'schtasks',
      task: WIN_TASK_NAME,
      killed_pid: killed ? pid : null,
      removed_task: del.code === 0,
      notes: ['Stopped serve and removed the logon task (re-add with `snazi start`).'],
    },
  }
}

// ---------------------------------------------------------------------------
// Public API — dispatch on platform.
// ---------------------------------------------------------------------------

function unsupported(action: string): ServiceResult {
  return {
    code: 2,
    result: {
      ok: false,
      action,
      manager: 'none',
      error: `Background service management isn't supported on platform '${process.platform}'.`,
      notes: ['Run `snazi serve` directly under your own process supervisor.'],
    },
  }
}

/** Install (if needed) and (re)start the background serve gate. */
export async function serviceStart(cfg: Config, opts: ServiceOptions): Promise<ServiceResult> {
  switch (process.platform) {
    case 'darwin':
      return startDarwin(cfg, opts)
    case 'linux':
      return startLinux(cfg, opts)
    case 'win32':
      return startWindows(cfg, opts)
    default:
      return unsupported('start')
  }
}

/** Stop the background serve gate and remove its auto-start entry. */
export function serviceStop(): ServiceResult {
  switch (process.platform) {
    case 'darwin':
      return stopDarwin()
    case 'linux':
      return stopLinux()
    case 'win32':
      return stopWindows()
    default:
      return unsupported('stop')
  }
}

/** Stop then start, so config/bind/port changes take effect. */
export async function serviceRestart(cfg: Config, opts: ServiceOptions): Promise<ServiceResult> {
  const stopped = serviceStop()
  const started = await serviceStart(cfg, opts)
  started.result.action = 'restart'
  started.result.stopped_first = (stopped.result.ok as boolean) ?? true
  return started
}

/** Best-effort status of the background service (read-only; never throws). */
export async function serviceStatus(cfg: Config): Promise<Record<string, unknown>> {
  const platform = process.platform
  try {
    let bind = '127.0.0.1'
    let port = DEFAULT_PORT
    try {
      bind = resolveBind(cfg, {})
    } catch {
      // keep loopback default
    }
    try {
      port = resolvePort(cfg, undefined)
    } catch {
      // keep default port
    }

    let installed = false
    let state: string | undefined
    if (platform === 'darwin') {
      installed = fs.existsSync(darwinPlistPath())
      const list = run('launchctl', ['list', LABEL])
      state = list.ran && list.code === 0 ? 'loaded' : 'not loaded'
    } else if (platform === 'linux') {
      const isEnabled = run('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT])
      installed = isEnabled.stdout.trim() === 'enabled'
      const isActive = run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT])
      state = isActive.stdout.trim() || 'unknown'
    } else if (platform === 'win32') {
      const query = run('schtasks', ['/Query', '/TN', WIN_TASK_NAME])
      installed = query.ran && query.code === 0
      state = installed ? 'registered' : 'not registered'
    }

    const health = await probeHealth(bind, port)
    return {
      manager: managerName(platform),
      installed,
      state,
      bind,
      port,
      healthy: health.ok,
      version: health.version ?? null,
    }
  } catch (e) {
    return { manager: managerName(platform), error: String(e instanceof Error ? e.message : e) }
  }
}
