import { currentUserId } from '@/lib/currentUser'
import { listSenders, listChannels } from '@/lib/data'
import type { Channel, Sender } from '@/lib/types'
import { addSender, setStatus, removeSender } from './actions'
import Landing from './landing'
import { SenderLabelEditor } from './sender-label-editor'

export const dynamic = 'force-dynamic'

async function loadData(
  ownerId: string
): Promise<{ channels: Channel[]; senders: Sender[] }> {
  // Both are scoped to this owner via the data-layer choke point.
  const [channels, senders] = await Promise.all([
    listChannels(ownerId),
    listSenders(ownerId),
  ])
  return { channels, senders }
}

function channelName(channels: Channel[], slug: string): string {
  return channels.find((c) => c.slug === slug)?.name ?? slug
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
  // Domain wildcards are stored as `*@domain` — surface them as a whole-domain
  // rule rather than a literal address.
  const isDomain = s.sender_address.startsWith('*@')
  const domain = isDomain ? s.sender_address.slice(2) : null
  const primary = s.label || (isDomain ? `@${domain}` : s.sender_address)

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-stone-50/60">
      <div className="min-w-0 flex-1">
        {isDomain ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className="truncate font-semibold text-ink"
              title={`Everyone @${domain}`}
            >
              @{domain}
            </span>
            <span className="pill bg-stone-200 px-2 py-0.5 text-[11px] font-semibold text-stone-600">
              🌐 All senders
            </span>
          </div>
        ) : (
          <SenderLabelEditor
            key={`${s.id}-${s.label ?? ''}`}
            channelId={s.channel_id}
            senderAddress={s.sender_address}
            label={s.label}
          />
        )}
        {showChannel && (
          <div className="mt-1 text-xs text-stone-500">
            <span className="rounded bg-stone-100 px-1.5 py-0.5">
              {channelName(channels, s.channel_id)}
            </span>
          </div>
        )}
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
            <button className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50">
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
            <button className="rounded-lg border border-emerald-200 px-3 py-1.5 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-50">
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
            className="rounded-lg px-2 py-1.5 text-sm text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
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
  const dot = accent === 'green' ? 'bg-emerald-500' : 'bg-red-500'
  const count =
    accent === 'green'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-red-100 text-red-700'
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-700">
          {title}
        </h2>
        <span className={`pill ${count} px-2 py-0.5`}>{list.length}</span>
      </div>

      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-5 text-sm text-stone-400">
          {emptyText}
        </p>
      ) : (
        <ul className="card divide-y divide-stone-100 overflow-hidden">
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

function DecisionBanner({
  done,
  name,
}: {
  done?: string
  name?: string
}) {
  if (done !== 'allow' && done !== 'block') return null

  const who = name?.trim()
  const allowText = who
    ? `Allowed — your agent can now read messages from ${who}.`
    : 'Allowed — your agent can now read messages from this person.'
  const blockText = who
    ? `Blocked — your agent will ignore ${who}.`
    : 'Blocked — your agent will ignore them.'

  if (done === 'allow') {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
        {allowText}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
      {blockText}
    </div>
  )
}

export default async function Home({
  searchParams,
}: {
  searchParams: { done?: string; name?: string }
}) {
  const ownerId = await currentUserId()
  // Logged-out visitors get the public marketing landing page.
  if (!ownerId) return <Landing />
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
  const defaultChannel = channels[0]?.slug ?? 'imessage'

  return (
    <div className="container-app space-y-7 py-8 sm:py-10">
      <DecisionBanner done={searchParams.done} name={searchParams.name} />

      {/* Intro */}
      <div>
        <span className="eyebrow">Your sender list</span>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          Who can reach your agent?
        </h1>
        <p className="mt-1.5 text-sm text-stone-500">
          Allow the people you trust. Block the ones you don’t. Everyone else
          is ignored.
        </p>
      </div>

      {/* Primary action: add someone */}
      <section className="card p-4 sm:p-5">
        <form
          action={addSender}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          {multiChannel ? (
            <label className="field-label sm:w-40">
              Channel
              <select
                name="channel_id"
                defaultValue={defaultChannel}
                className="input"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="channel_id" value={defaultChannel} />
          )}

          <label className="field-label flex-1">
            <span className="h-4 whitespace-nowrap leading-4">
              Phone number or email
            </span>
            <input
              name="sender_address"
              required
              placeholder="+1 555 123 4567"
              className="input"
            />
          </label>

          <label className="field-label sm:w-48">
            <span className="h-4 whitespace-nowrap leading-4">
              Name <span className="text-stone-400">(optional)</span>
            </span>
            <input name="label" placeholder="Mom" className="input" />
          </label>

          <div className="flex gap-2">
            <button
              type="submit"
              name="status"
              value="approved"
              className="btn-allow flex-1 sm:w-24 sm:flex-none"
            >
              Allow
            </button>
            <button
              type="submit"
              name="status"
              value="denied"
              className="btn flex-1 bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800 sm:w-24 sm:flex-none"
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
          emptyText="No one is blocked yet. Add someone above to keep them away from your agent."
          list={denied}
          channels={channels}
          showChannel={multiChannel}
        />
      </div>
    </div>
  )
}
