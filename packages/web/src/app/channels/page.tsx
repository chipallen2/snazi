import { redirect } from 'next/navigation'
import { currentUserId } from '@/lib/currentUser'
import { listChannels, listChannelTypes } from '@/lib/data'
import type { Channel, ChannelType } from '@/lib/types'
import { addChannel, removeChannel } from './actions'

export const dynamic = 'force-dynamic'

function typeName(types: ChannelType[], id: string): string {
  return types.find((t) => t.id === id)?.display_name ?? id
}

function ChannelRow({ c, types }: { c: Channel; types: ChannelType[] }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-stone-50/60">
      <div className="min-w-0">
        <div className="truncate font-semibold text-ink">{c.name}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
          <span className="pill bg-stone-100 px-1.5 py-0.5 text-stone-600">
            {typeName(types, c.type)}
          </span>
          <span className="font-mono">{c.slug}</span>
        </div>
      </div>
      <form action={removeChannel.bind(null, c.slug)}>
        <button
          title="Delete this channel and its list"
          aria-label={`Delete ${c.name}`}
          className="rounded-lg px-2 py-1.5 text-sm text-stone-300 transition-colors hover:bg-stone-100 hover:text-red-600"
        >
          ✕
        </button>
      </form>
    </li>
  )
}

export default async function ChannelsPage() {
  const ownerId = await currentUserId()
  if (!ownerId) redirect('/login?next=/channels')

  const [channels, types] = await Promise.all([
    listChannels(ownerId),
    listChannelTypes(),
  ])
  const defaultType = types[0]?.id ?? 'imessage'

  return (
    <div className="container-app space-y-7 py-8 sm:py-10">
      <div>
        <span className="eyebrow">Channels</span>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          Your channels
        </h1>
        <p className="mt-1.5 text-sm text-stone-500">
          A channel is one connection your agent reads — give it a name. You can
          have several of the same type (e.g. a{' '}
          <span className="font-medium text-stone-700">Personal</span> and a{' '}
          <span className="font-medium text-stone-700">Work</span> Gmail). Each
          channel has its own approve / deny list.
        </p>
      </div>

      {/* Add a channel */}
      <section className="card p-4 sm:p-5">
        <form
          action={addChannel}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="field-label sm:w-40">
            Type
            <select name="type" defaultValue={defaultType} className="input">
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </label>

          <label className="field-label flex-1">
            Name
            <input name="name" required placeholder="Work" className="input" />
          </label>

          <label className="field-label sm:w-48">
            <span className="whitespace-nowrap">
              Slug <span className="text-stone-400">(optional)</span>
            </span>
            <input
              name="slug"
              placeholder="outlook-work"
              pattern="[a-z0-9_-]+"
              title="lowercase letters, numbers, dashes, underscores"
              className="input font-mono"
            />
          </label>

          <button type="submit" className="btn-allow sm:w-28 sm:flex-none">
            Add channel
          </button>
        </form>
        <p className="mt-3 text-xs text-stone-400">
          Adding a channel here only registers its name + type so this list can
          show it. Credentials (OAuth tokens / app passwords) are configured
          separately on your CLI machine and never touch this server.{' '}
          <strong>Slug</strong> is what the CLI uses as{' '}
          <code className="rounded bg-stone-100 px-1">--channel</code>: set it to
          match your CLI channel id (e.g.{' '}
          <code className="rounded bg-stone-100 px-1">outlook-work</code>), or
          leave blank to auto-generate.
        </p>
      </section>

      {/* Existing channels */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-700">
            Channels
          </h2>
          <span className="pill bg-stone-100 px-2 py-0.5 text-stone-600">
            {channels.length}
          </span>
        </div>
        {channels.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-5 text-sm text-stone-400">
            No channels yet. Add one above.
          </p>
        ) : (
          <ul className="card divide-y divide-stone-100 overflow-hidden">
            {channels.map((c) => (
              <ChannelRow key={c.id} c={c} types={types} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
