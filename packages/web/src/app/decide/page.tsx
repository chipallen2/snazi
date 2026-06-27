import Link from 'next/link'
import { currentUserId } from '@/lib/currentUser'
import { getSender, getChannelBySlug } from '@/lib/data'
import type { CheckStatus } from '@/lib/types'
import { normalizeAddress } from '@/lib/address'
import { resolveDecideOwner } from '@/lib/session'
import { decideStatus } from '../actions'

export const dynamic = 'force-dynamic'

async function lookup(
  owner: string,
  channel: string,
  sender: string
): Promise<{ status: CheckStatus; label: string | null; channelName: string }> {
  const [existing, channelRow] = await Promise.all([
    getSender(owner, channel, sender),
    getChannelBySlug(owner, channel),
  ])
  return {
    status: (existing?.status as CheckStatus) ?? 'unknown',
    label: existing?.label ?? null,
    channelName: channelRow?.name ?? channel,
  }
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 text-sm font-semibold text-stone-400 hover:text-stone-700"
    >
      ← All senders
    </Link>
  )
}

function StatusPill({ status }: { status: CheckStatus }) {
  const map = {
    approved: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Currently allowed' },
    denied: { dot: 'bg-red-500', text: 'text-red-700', label: 'Currently blocked' },
    unknown: { dot: 'bg-stone-300', text: 'text-stone-500', label: 'Not decided yet' },
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
    exp?: string
    sig?: string
  }
}) {
  const channel = (searchParams.channel || 'imessage').trim() || 'imessage'
  const sender = normalizeAddress(searchParams.sender || '')
  const passedLabel = (searchParams.label || '').trim()
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
      <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
        <div className="card w-full max-w-md p-6 text-center">
          <h1 className="text-lg font-bold text-ink">Nothing to decide</h1>
          <p className="mt-2 text-sm text-stone-500">
            This link is missing a sender, so there’s no one to allow or block.
          </p>
        </div>
        <BackLink />
      </div>
    )
  }

  // No resolvable owner → the link is expired/invalid and there's no session.
  // (Middleware normally blocks this; guard anyway so we never query with an
  // empty owner.) Point them at sign-in rather than erroring.
  if (!owner) {
    return (
      <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
        <div className="card w-full max-w-md p-6 text-center">
          <h1 className="text-lg font-bold text-ink">Link expired</h1>
          <p className="mt-2 text-sm text-stone-500">
            This one-tap link is no longer valid. Sign in to manage who can reach
            your agent.
          </p>
        </div>
        <Link
          href="/login"
          className="inline-flex items-center gap-1 text-sm font-semibold text-stone-400 hover:text-stone-700"
        >
          Sign in →
        </Link>
      </div>
    )
  }

  const { status, label, channelName } = await lookup(owner, channel, sender)
  const displayLabel = label || passedLabel
  const primary = displayLabel || sender
  const sub = displayLabel ? sender : null

  return (
    <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
      <div className="card w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="border-b border-stone-100 px-6 pb-5 pt-6">
          <p className="eyebrow">Should your agent read messages from</p>
          <h1 className="mt-2 break-words text-2xl font-extrabold tracking-tight text-ink">
            {primary}
          </h1>
          {sub && (
            <p className="mt-1 break-all font-mono text-sm text-stone-500">{sub}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              {channelName}
            </span>
            <StatusPill status={status} />
          </div>
        </div>

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
              className="btn-allow btn-lg w-full py-4"
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
              className="btn btn-lg w-full bg-red-600 py-4 text-white shadow-sm hover:bg-red-700 active:bg-red-800"
            >
              Block
            </button>
          </form>

          <p className="pt-1 text-center text-xs text-stone-400">
            Allow lets your agent read &amp; summarize their messages. Block (or
            no decision) means their messages stay private.
          </p>
        </div>
      </div>

      <BackLink />
    </div>
  )
}
