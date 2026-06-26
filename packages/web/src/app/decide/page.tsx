import Link from 'next/link'
import { getSupabase } from '@/lib/supabase'
import { currentUserId } from '@/lib/currentUser'
import { getSender } from '@/lib/data'
import type { Channel, CheckStatus } from '@/lib/types'
import { normalizeAddress } from '@/lib/address'
import { resolveDecideOwner } from '@/lib/session'
import { decideStatus } from '../actions'

export const dynamic = 'force-dynamic'

async function lookup(
  owner: string,
  channel: string,
  sender: string
): Promise<{ status: CheckStatus; label: string | null; channelName: string }> {
  const supabase = getSupabase()
  const [existing, { data: channelRow }] = await Promise.all([
    getSender(owner, channel, sender),
    supabase.from('sna_channels').select('*').eq('id', channel).maybeSingle(),
  ])
  return {
    status: (existing?.status as CheckStatus) ?? 'unknown',
    label: existing?.label ?? null,
    channelName: (channelRow as Channel)?.display_name ?? channel,
  }
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 text-sm font-medium text-neutral-400 hover:text-neutral-700"
    >
      ← All senders
    </Link>
  )
}

function StatusPill({ status }: { status: CheckStatus }) {
  const map = {
    approved: { dot: 'bg-green-500', text: 'text-green-700', label: 'Currently allowed' },
    denied: { dot: 'bg-red-500', text: 'text-red-700', label: 'Currently blocked' },
    unknown: { dot: 'bg-neutral-300', text: 'text-neutral-500', label: 'Not decided yet' },
  }[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${map.text}`}>
      <span className={`h-2 w-2 rounded-full ${map.dot}`} />
      {map.label}
    </span>
  )
}

export default async function Decide({
  searchParams,
}: {
  searchParams: {
    owner?: string
    channel?: string
    sender?: string
    label?: string
    done?: string
    exp?: string
    sig?: string
  }
}) {
  const channel = (searchParams.channel || 'imessage').trim() || 'imessage'
  const sender = normalizeAddress(searchParams.sender || '')
  const passedLabel = (searchParams.label || '').trim()
  const done = searchParams.done
  // Capability-link proof, threaded through so the POST action can re-verify
  // it (server actions are independently POST-able and must not trust the page
  // gate alone).
  const exp = searchParams.exp || ''
  const sig = searchParams.sig || ''
  // Owner resolution is shared with the POST action (resolveDecideOwner): a
  // valid signed link wins (it carries its own owner), else the logged-in
  // session user. This guarantees the form we render writes to the SAME tenant
  // the action will authorize — a logged-in user tapping someone else's signed
  // link decides for the LINK's owner, never silently for their own list.
  const sessionUserId = await currentUserId()
  const owner =
    (await resolveDecideOwner({
      ownerParam: searchParams.owner,
      channel,
      sender,
      exp: Number(exp),
      sig,
      sessionUserId,
    })) || ''

  // No sender → friendly guidance, link home.
  if (!sender) {
    return (
      <div className="mx-auto max-w-md space-y-5">
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-bold text-neutral-900">Nothing to decide</h1>
          <p className="mt-2 text-sm text-neutral-500">
            This link is missing a sender, so there’s no one to allow or block.
          </p>
        </div>
        <div className="text-center">
          <BackLink />
        </div>
      </div>
    )
  }

  // No resolvable owner → the link is expired/invalid and there's no session.
  // (Middleware normally blocks this; guard anyway so we never query with an
  // empty owner.) Point them at sign-in rather than erroring.
  if (!owner) {
    return (
      <div className="mx-auto max-w-md space-y-5">
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-bold text-neutral-900">Link expired</h1>
          <p className="mt-2 text-sm text-neutral-500">
            This one-tap link is no longer valid. Sign in to manage who can reach
            your agent.
          </p>
        </div>
        <div className="text-center">
          <Link
            href="/login"
            className="inline-flex items-center gap-1 text-sm font-medium text-neutral-400 hover:text-neutral-700"
          >
            Sign in →
          </Link>
        </div>
      </div>
    )
  }

  const { status, label, channelName } = await lookup(owner, channel, sender)
  const displayLabel = label || passedLabel
  const primary = displayLabel || sender
  const sub = displayLabel ? sender : null

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-neutral-100 px-6 pb-5 pt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Should your agent read messages from
          </p>
          <h1 className="mt-2 break-words text-2xl font-bold tracking-tight text-neutral-900">
            {primary}
          </h1>
          {sub && (
            <p className="mt-1 break-all font-mono text-sm text-neutral-500">{sub}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
              {channelName}
            </span>
            <StatusPill status={status} />
          </div>
        </div>

        {/* Confirmation banner (after a decision) */}
        {done === 'allow' && (
          <div className="border-b border-green-100 bg-green-50 px-6 py-3 text-sm font-medium text-green-800">
            Allowed — your agent can now read messages from this person.
          </div>
        )}
        {done === 'block' && (
          <div className="border-b border-red-100 bg-red-50 px-6 py-3 text-sm font-medium text-red-800">
            Blocked — your agent will ignore them.
          </div>
        )}

        {/* Decision buttons (always shown so the user can change their mind) */}
        <div className="space-y-3 px-6 py-6">
          <form action={decideStatus}>
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="channel_id" value={channel} />
            <input type="hidden" name="sender_address" value={sender} />
            <input type="hidden" name="label" value={displayLabel} />
            <input type="hidden" name="exp" value={exp} />
            <input type="hidden" name="sig" value={sig} />
            <input type="hidden" name="status" value="approved" />
            <button
              type="submit"
              className="w-full rounded-xl bg-green-600 px-4 py-4 text-base font-semibold text-white shadow-sm hover:bg-green-700 active:bg-green-800"
            >
              Allow
            </button>
          </form>

          <form action={decideStatus}>
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="channel_id" value={channel} />
            <input type="hidden" name="sender_address" value={sender} />
            <input type="hidden" name="label" value={displayLabel} />
            <input type="hidden" name="exp" value={exp} />
            <input type="hidden" name="sig" value={sig} />
            <input type="hidden" name="status" value="denied" />
            <button
              type="submit"
              className="w-full rounded-xl bg-neutral-800 px-4 py-4 text-base font-semibold text-white shadow-sm hover:bg-neutral-900 active:bg-black"
            >
              Block
            </button>
          </form>

          <p className="pt-1 text-center text-xs text-neutral-400">
            Allow lets your agent read &amp; summarize their messages. Block (or
            no decision) means their messages stay private.
          </p>
        </div>
      </div>

      <div className="text-center">
        <BackLink />
      </div>
    </div>
  )
}
