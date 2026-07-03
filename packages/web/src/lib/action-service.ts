/**
 * Server-side execution + notification for approved capability actions.
 *
 * When an owner taps "Approve" on the /decide page, the action must actually
 * RUN (call Schwab, etc.) and the owner must be told the outcome. Both of those
 * live here so the /decide server action and the /api/actions/[code]/decide
 * route share one implementation.
 *
 * SAFETY: this module runs ONLY after the action's HMAC signature + owner have
 * been verified and the status has been compare-and-set from `pending`, so it
 * can never execute a forged or already-executed action.
 */
import type { Action } from './types'
import { getActionByShortcode, updateActionStatus } from './data'
import { verifyAction } from './session'

export interface ExecutionResult {
  ok: boolean
  /** Machine-readable outcome (stored in sna_actions.result). */
  result: Record<string, unknown>
  /** Short human-readable summary for the approval notification. */
  summary: string
}

/**
 * Execute an approved action by its `type`.
 *
 * v1 SCOPE: Chip enabled READ-ONLY Schwab access first, so the trade-execution
 * path is a deliberate, clearly-labeled STUB. The full approval + signing +
 * notification flow runs end-to-end; only the final "place the order" call is
 * withheld until trading is explicitly turned on. This never throws — a failure
 * is captured as a structured result so the caller can record + report it.
 */
export async function executeApprovedAction(action: Action): Promise<ExecutionResult> {
  try {
    switch (action.type) {
      case 'schwab_trade':
        return executeSchwabTradeStub(action)
      default:
        return {
          ok: false,
          result: { error: `Unknown action type '${action.type}'.` },
          summary: `Unknown action type '${action.type}'. Nothing was executed.`,
        }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      result: { error: msg },
      summary: `Execution failed: ${msg}`,
    }
  }
}

export type DecisionOutcome =
  | { ok: true; status: 'denied'; summary: string }
  | { ok: true; status: 'executed'; execOk: boolean; summary: string }
  | {
      ok: false
      code: 'not_found' | 'unauthorized' | 'expired' | 'already'
      status?: string
      summary: string
    }

/**
 * Apply an owner's decision (approve/deny) to a pending action, executing +
 * notifying on approve. Shared by the /decide server action and the
 * /api/actions/[code]/decide route so both entry points are identical.
 *
 * AUTHORIZATION (defense in depth, fails closed):
 *   1. The shortcode must resolve to a real action row.
 *   2. The row's own stored HMAC signature must re-verify against
 *      owner+shortcode+exp (proves the row was minted by our signer and not
 *      tampered with) OR a logged-in session must own the row.
 *   3. The action must be unexpired and still `pending`.
 *
 * IDEMPOTENCY / RACE SAFETY: the approve path uses a compare-and-set from
 * `pending` -> `approved`, so two taps of Approve can never double-execute.
 */
export async function runActionDecision(input: {
  code: string
  decision: 'approved' | 'denied'
  sessionUserId?: string | null
}): Promise<DecisionOutcome> {
  const { code, decision, sessionUserId } = input
  const row = await getActionByShortcode(code)
  if (!row) {
    return { ok: false, code: 'not_found', summary: 'Action not found.' }
  }

  const expMs = new Date(row.exp).getTime()
  const sigOk = await verifyAction(row.owner_id, code, expMs, row.sig)
  const sessionOk = !!sessionUserId && sessionUserId === row.owner_id
  if (!sigOk && !sessionOk) {
    return { ok: false, code: 'unauthorized', summary: 'Not authorized for this action.' }
  }

  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    // Best-effort mark expired so the UI reflects reality; ignore failures.
    if (row.status === 'pending') {
      try {
        await updateActionStatus(row.owner_id, code, { status: 'expired' }, 'pending')
      } catch {
        /* best-effort */
      }
    }
    return { ok: false, code: 'expired', summary: 'This action link has expired.' }
  }

  if (row.status !== 'pending') {
    return {
      ok: false,
      code: 'already',
      status: row.status,
      summary: `This action was already ${row.status}.`,
    }
  }

  if (decision === 'denied') {
    const updated = await updateActionStatus(
      row.owner_id,
      code,
      { status: 'denied' },
      'pending'
    )
    if (!updated) {
      return { ok: false, code: 'already', summary: 'This action was already decided.' }
    }
    await notifyServeHost(`\u274c Action DENIED: ${row.description}`)
    return { ok: true, status: 'denied', summary: row.description }
  }

  // Approve: compare-and-set pending -> approved FIRST so a concurrent tap can't
  // also execute. Only the winner of that CAS proceeds to run the action.
  const claimed = await updateActionStatus(
    row.owner_id,
    code,
    { status: 'approved' },
    'pending'
  )
  if (!claimed) {
    return { ok: false, code: 'already', summary: 'This action was already decided.' }
  }

  const exec = await executeApprovedAction(row)
  await updateActionStatus(row.owner_id, code, {
    status: 'executed',
    executed_at: new Date().toISOString(),
    result: exec.result,
  })
  const icon = exec.ok ? '\u2705' : '\u26a0\ufe0f'
  await notifyServeHost(`${icon} Action APPROVED: ${row.description}\n${exec.summary}`)
  return { ok: true, status: 'executed', execOk: exec.ok, summary: exec.summary }
}

/**
 * STUB for schwab_trade. Returns a clear "trading not yet enabled" result so the
 * approval UX is fully exercised without placing a real order. When trading is
 * turned on, replace this with a call to Schwab's order-placement API (which,
 * per the architecture, would proxy through the serve host that holds the
 * Schwab credentials — the web tier never sees Schwab secrets).
 */
function executeSchwabTradeStub(action: Action): ExecutionResult {
  const p = action.payload || {}
  const desc =
    typeof action.description === 'string' && action.description
      ? action.description
      : `${String(p.side ?? '')} ${String(p.qty ?? '')} ${String(p.symbol ?? '')}`.trim()
  return {
    ok: false,
    result: {
      status: 'not_executed',
      reason: 'trading_not_enabled',
      note: 'Schwab trading is not yet enabled (read-only mode). Order was approved but not placed.',
      approved_payload: p,
    },
    summary: `Approved but NOT placed — Schwab trading is read-only for now. (${desc})`,
  }
}

/**
 * Best-effort notification to the owner via the serve host's /notify endpoint.
 * NEVER throws: a notification failure must not roll back an approval/execution
 * that already happened. Returns whether the notification was dispatched.
 *
 * Config via env (set on the web/Vercel side):
 *   SNAZI_SERVE_URL     base URL of the serve host (default http://100.65.95.97:8787)
 *   SNAZI_SERVE_TOKEN   bearer token matching the serve host's serveToken
 *   SNAZI_NOTIFY_TO     recipient address/number (default: Chip)
 *   SNAZI_NOTIFY_CHANNEL serve channel to send through (default: imessage)
 *
 * NOTE: Vercel typically can't reach a tailnet 100.x address. If the serve host
 * isn't reachable from the web tier, leave SNAZI_SERVE_URL unset — the decision
 * still succeeds and this simply returns false. The agent (Gofer) can relay the
 * outcome to Chip over Telegram instead.
 */
export async function notifyServeHost(message: string): Promise<boolean> {
  const base = (process.env.SNAZI_SERVE_URL || '').replace(/\/+$/, '')
  const token = process.env.SNAZI_SERVE_TOKEN || ''
  const to = process.env.SNAZI_NOTIFY_TO || '8565945588'
  const channel = process.env.SNAZI_NOTIFY_CHANNEL || 'imessage'
  if (!base || !token) return false
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to, channel, message }),
      cache: 'no-store',
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}
