import { redirect } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { currentUserId } from '@/lib/currentUser'
import { listSenders } from '@/lib/data'
import type { Channel, Sender } from '@/lib/types'
import { addSender, setStatus, removeSender } from './actions'

export const dynamic = 'force-dynamic'

async function loadData(
  ownerId: string
): Promise<{ channels: Channel[]; senders: Sender[] }> {
  const supabase = getSupabase()
  const [{ data: channels }, senders] = await Promise.all([
    // Channels are a GLOBAL registry of channel types (shared reference data).
    supabase.from('sna_channels').select('*').order('id'),
    // Senders are scoped to this owner via the data-layer choke point.
    listSenders(ownerId),
  ])
  return {
    channels: (channels as Channel[]) ?? [],
    senders,
  }
}

function channelName(channels: Channel[], id: string): string {
  return channels.find((c) => c.id === id)?.display_name ?? id
}

/** One person in a list. Label (or address) is primary; a single clear
 *  toggle is the action. Status is implied by which list it's in. */
function SenderRow({
  s,
  channels,
  showChannel,
}: {
  s: Sender
  channels: Channel[]
  showChannel: boolean
}) {
  const isApproved = s.status === 'approved'
  const primary = s.label || s.sender_address
  const sub = s.label ? s.sender_address : null

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium text-neutral-900">{primary}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
          {sub && <span className="font-mono">{sub}</span>}
          {showChannel && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5">
              {channelName(channels, s.channel_id)}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isApproved ? (
          <form
            action={setStatus.bind(
              null,
              s.channel_id,
              s.sender_address,
              'denied'
            )}
          >
            <button className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">
              Block
            </button>
          </form>
        ) : (
          <form
            action={setStatus.bind(
              null,
              s.channel_id,
              s.sender_address,
              'approved'
            )}
          >
            <button className="rounded-md border border-green-200 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50">
              Allow
            </button>
          </form>
        )}
        <form
          action={removeSender.bind(null, s.channel_id, s.sender_address)}
        >
          <button
            title="Remove from list"
            aria-label={`Remove ${primary}`}
            className="rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
        </form>
      </div>
    </li>
  )
}

function SenderList({
  title,
  accent,
  emptyText,
  list,
  channels,
  showChannel,
}: {
  title: string
  accent: 'green' | 'red'
  emptyText: string
  list: Sender[]
  channels: Channel[]
  showChannel: boolean
}) {
  const dot = accent === 'green' ? 'bg-green-500' : 'bg-red-500'
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          {title}
        </h2>
        <span className="text-xs text-neutral-400">{list.length}</span>
      </div>

      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-200 bg-white px-4 py-5 text-sm text-neutral-400">
          {emptyText}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
          {list.map((s) => (
            <SenderRow
              key={s.id}
              s={s}
              channels={channels}
              showChannel={showChannel}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export default async function Home() {
  const ownerId = await currentUserId()
  if (!ownerId) redirect('/login')
  const { channels, senders } = await loadData(ownerId)

  const approved = senders
    .filter((s) => s.status === 'approved')
    .sort((a, b) =>
      (a.label || a.sender_address).localeCompare(b.label || b.sender_address)
    )
  const denied = senders
    .filter((s) => s.status === 'denied')
    .sort((a, b) =>
      (a.label || a.sender_address).localeCompare(b.label || b.sender_address)
    )

  const multiChannel = channels.length > 1
  const defaultChannel = channels[0]?.id ?? 'imessage'

  return (
    <div className="space-y-7">
      {/* Intro */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
          Who can reach your agent?
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Allow the people you trust. Block the ones you don’t. Everyone else
          is ignored.
        </p>
      </div>

      {/* Primary action: add someone */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
        <form
          action={addSender}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          {multiChannel ? (
            <label className="flex flex-col text-xs font-medium text-neutral-600 sm:w-40">
              Channel
              <select
                name="channel_id"
                defaultValue={defaultChannel}
                className="mt-1 rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-900"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="channel_id" value={defaultChannel} />
          )}

          <label className="flex flex-1 flex-col text-xs font-medium text-neutral-600">
            Phone number or email
            <input
              name="sender_address"
              required
              placeholder="+1 555 123 4567"
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>

          <label className="flex flex-col text-xs font-medium text-neutral-600 sm:w-44">
            Name <span className="text-neutral-400">(optional)</span>
            <input
              name="label"
              placeholder="Mom"
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="submit"
              name="status"
              value="approved"
              className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 sm:flex-none"
            >
              Allow
            </button>
            <button
              type="submit"
              name="status"
              value="denied"
              className="flex-1 rounded-lg bg-neutral-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-900 sm:flex-none"
            >
              Block
            </button>
          </div>
        </form>
      </section>

      {/* The two lists */}
      <div className="space-y-7">
        <SenderList
          title="Allowed"
          accent="green"
          emptyText="No one is allowed yet. Add someone above to let them reach your agent."
          list={approved}
          channels={channels}
          showChannel={multiChannel}
        />
        <SenderList
          title="Blocked"
          accent="red"
          emptyText="No one is blocked."
          list={denied}
          channels={channels}
          showChannel={multiChannel}
        />
      </div>
    </div>
  )
}
