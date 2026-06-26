/**
 * Send iMessage via Messages.app (macOS only).
 *
 * Outbound messages are NEVER gated by the approval list — the soup nazi only
 * blocks reading. Sending uses AppleScript (`osascript`) and does not require
 * Full Disk Access to chat.db; it may require Automation permission for Messages.
 */
import { execFileSync } from 'child_process'
import { validateRecipientAddress } from './address'

export const MAX_MESSAGE_LEN = 10_000

/** Escape a string for embedding in an AppleScript double-quoted literal. */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export interface SendAvailability {
  available: boolean
  reason?: string
  detail?: string
}

const AUTOMATION_HINT =
  'Grant Automation permission for Messages in System Settings > Privacy & ' +
  'Security > Automation (or allow the terminal/node to control Messages).'

/** Can iMessage be sent from this host right now? */
export function probeSendAvailability(): SendAvailability {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      reason: `iMessage can only be sent on macOS (this host is ${process.platform}).`,
    }
  }
  try {
    const out = execFileSync(
      'osascript',
      ['-e', 'application "Messages" exists'],
      { encoding: 'utf8', timeout: 5_000 }
    ).trim()
    if (out !== 'true') {
      return {
        available: false,
        reason: 'Messages.app is not installed on this Mac.',
      }
    }
    return { available: true }
  } catch (e) {
    return {
      available: false,
      reason: `Cannot reach Messages.app: ${String(e instanceof Error ? e.message : e)}`,
      detail: AUTOMATION_HINT,
    }
  }
}

/**
 * Send one iMessage. Throws on validation or delivery failure.
 * Never checks the approval list — sending is always allowed.
 */
export function sendIMessage(rawRecipient: string, text: string): void {
  const recipient = validateRecipientAddress(rawRecipient)
  if (recipient.length > 128) {
    throw new Error('Recipient too long.')
  }
  const body = String(text ?? '')
  if (!body.trim()) {
    throw new Error('Missing message text.')
  }
  if (body.length > MAX_MESSAGE_LEN) {
    throw new Error(`Message too long (max ${MAX_MESSAGE_LEN} characters).`)
  }
  // Block control chars (except common whitespace) to keep logs/terminals safe.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw new Error('Invalid message text.')
  }

  if (process.platform !== 'darwin') {
    throw new Error(`iMessage can only be sent on macOS (this host is ${process.platform}).`)
  }

  const escapedRecipient = escapeAppleScriptString(recipient)
  const escapedText = escapeAppleScriptString(body)
  const script = [
    'tell application "Messages"',
    '  set targetService to 1st service whose service type = iMessage',
    `  set targetBuddy to participant "${escapedRecipient}" of targetService`,
    `  send "${escapedText}" to targetBuddy`,
    'end tell',
  ].join('\n')

  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 30_000 })
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e)
    if (/Not authorized|(-1743)/.test(msg)) {
      throw new Error(`Messages automation denied. ${AUTOMATION_HINT}`)
    }
    throw new Error(`Send failed: ${msg}`)
  }
}
