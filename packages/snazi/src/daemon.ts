/**
 * snazi serve --install-daemon — install the launchd LaunchAgent.
 *
 * Writes ~/Library/LaunchAgents/com.soup-nazi.snazi-serve.plist from the
 * template, substituting the real node binary, CLI path, bind, and port. Then
 * prints the `launchctl` load/unload commands and the Full Disk Access note.
 *
 * We intentionally do NOT auto-`launchctl load` here: loading a LaunchAgent and
 * granting Full Disk Access is a deliberate, user-visible action. We print the
 * exact commands instead so it stays transparent.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Config } from './config'
import { resolveBind } from './server'

export const LABEL = 'com.soup-nazi.snazi-serve'

// Mirrors server.ts port policy (kept local to avoid coupling).
function pickPort(cfg: Config, port?: number): number {
  const p = port ?? cfg.servePort ?? 8787
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`Invalid port: ${p}`)
  }
  return p
}

export interface InstallDaemonOptions {
  bind?: string
  port?: number
}

export function installDaemon(
  cfg: Config,
  opts: InstallDaemonOptions
): { plistPath: string; bind: string; port: number; node: string; cli: string } {
  const node = process.execPath
  // dist/daemon.js -> dist/cli.js
  const cli = path.join(__dirname, 'cli.js')
  if (!fs.existsSync(cli)) {
    throw new Error(`Cannot find compiled CLI at ${cli}. Run 'npm run build' first.`)
  }

  const bind = resolveBind(cfg, { bind: opts.bind })
  const port = pickPort(cfg, opts.port)

  // Template lives next to package root: dist/daemon.js -> ../com.soup-nazi...
  const templatePath = path.join(__dirname, '..', 'com.soup-nazi.snazi-serve.plist')
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Plist template not found at ${templatePath}.`)
  }
  const logDir = path.join(os.homedir(), 'Library', 'Logs')

  const filled = fs
    .readFileSync(templatePath, 'utf8')
    .replace(/__NODE__/g, node)
    .replace(/__CLI__/g, cli)
    .replace(/__BIND__/g, bind)
    .replace(/__PORT__/g, String(port))
    .replace(/__LOGDIR__/g, logDir)

  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  fs.mkdirSync(agentsDir, { recursive: true })
  const plistPath = path.join(agentsDir, `${LABEL}.plist`)
  fs.writeFileSync(plistPath, filled, { mode: 0o644 })

  return { plistPath, bind, port, node, cli }
}
