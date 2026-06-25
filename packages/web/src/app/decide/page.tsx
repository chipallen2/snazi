import Link from 'next/link'
import { getSupabase } from '@/lib/supabase'
import type { Channel, CheckStatus, Sender } from '@/lib/types'
import { decideStatus } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * A "+" in a query string decodes to a space, so an E.164 number like
 * "+17207710284" arrives as " 17207710284". Restore the leading "+" so the
 * lookup matches what the CLI/DB stores. Numbers should be percent-encoded
 * (%2B), but this makes a stray space-encoded "+" round-trip too.
 */
function decodeSender(raw: string): string {
  let s = raw || ''
  if (/^ \d/.test(s)) s = '+' + s.slice(1)
  return s.trim()
}

async function lookup(
  channel: string,
  sender: string
): Promise<{ status: CheckStatus; existing: Sender | null; channelName: string }> {
  const supabase = getSupabase()
  const [{ data: senderRow }, { data: channelRow }] = await Promise.all([
    supabase
      .from('sna_senders')
      .select('*')
      .eq('channel_id', channel)
      .eq('sender_address', sender)
      .maybeSingle(),
    supabase.from('sna_channels').select('*').eq('id', channel).maybeSingle(),
  ])
  const existing = (senderRow as Sender) ?? null
  return {
    status: (existing?.status as CheckStatus) ?? 'unknown',
    existing,
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
    channel?: string
    sender?: string
    label?: string
  }
}) {
  const channel = (searchParams.channel || 'imessage').trim() || 'imessage'
  const sender = decodeSender(searchParams.sender || '')
  const passedLabel = (searchParams.label || '').trim()

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

  const { status, existing, channelName } = await lookup(channel, sender)
  const displayLabel = existing?.label || passedLabel
  const primary = displayLabel || sender
  const sub = displayLabel ? sender : null

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-neutral-100 px-6 pb-5 pt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Should your assistant read messages from
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

        {/* Decision form. One form, two submit buttons, plus an optional
            friendly name. Buttons always show so the decision can be changed;
            after submitting, decideStatus redirects home with a banner. */}
        <form action={decideStatus} className="space-y-3 px-6 py-6">
          <input type="hidden" name="channel_id" value={channel} />
          <input type="hidden" name="sender_address" value={sender} />

          <label className="block text-xs font-medium text-neutral-600">
            Name <span className="text-neutral-400">(optional)</span>
            <input
              name="label"
              defaultValue={displayLabel}
              placeholder="Mom"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>

          <button
            type="submit"
            name="status"
            value="approved"
            className="w-full rounded-xl bg-green-600 px-4 py-4 text-base font-semibold text-white shadow-sm hover:bg-green-700 active:bg-green-800"
          >
            Allow
          </button>

          <button
            type="submit"
            name="status"
            value="denied"
            className="w-full rounded-xl bg-neutral-800 px-4 py-4 text-base font-semibold text-white shadow-sm hover:bg-neutral-900 active:bg-black"
          >
            Block
          </button>

          <p className="pt-1 text-center text-xs text-neutral-400">
            Allow lets your assistant read &amp; summarize their messages. Block
            (or no decision) means their messages stay private.
          </p>
        </form>
      </div>

      <div className="text-center">
        <BackLink />
      </div>
    </div>
  )
}
