import { getSupabase } from '@/lib/supabase'
import type { Channel } from '@/lib/types'

export const dynamic = 'force-dynamic'

async function loadChannels(): Promise<Channel[]> {
  const supabase = getSupabase()
  const { data } = await supabase.from('sna_channels').select('*').order('id')
  return (data as Channel[]) ?? []
}

export default async function ChannelsPage() {
  const channels = await loadChannels()

  return (
    <div className="container-app space-y-5 py-8 sm:py-10">
      <div>
        <span className="eyebrow">Channels</span>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          Connected channels
        </h1>
        <p className="mt-1.5 text-sm text-stone-500">
          Communication channels gated by your approve / deny list. Read-only.
        </p>
      </div>

      {/* Desktop: table */}
      <div className="card hidden overflow-hidden sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-400">
              <th className="w-36 px-4 py-3 font-bold">ID</th>
              <th className="w-44 px-4 py-3 font-bold">Name</th>
              <th className="w-32 px-4 py-3 font-bold">Status</th>
              <th className="px-4 py-3 font-bold">Description</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr
                key={c.id}
                className="border-b border-stone-100 last:border-0 hover:bg-stone-50/60"
              >
                <td className="px-4 py-3 font-mono text-stone-600">{c.id}</td>
                <td className="px-4 py-3 font-semibold text-ink">
                  {c.display_name}
                </td>
                <td className="px-4 py-3">
                  <StatusPill enabled={c.enabled} />
                </td>
                <td className="px-4 py-3 text-stone-500">
                  {c.description || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards (no clipping) */}
      <div className="space-y-3 sm:hidden">
        {channels.map((c) => (
          <div key={c.id} className="card-pad">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-semibold text-ink">
                  {c.display_name}
                </div>
                <div className="truncate font-mono text-xs text-stone-400">
                  {c.id}
                </div>
              </div>
              <StatusPill enabled={c.enabled} />
            </div>
            {c.description && (
              <p className="mt-2 text-sm text-stone-500">{c.description}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`pill ${
        enabled
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-stone-200 text-stone-600'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? 'bg-emerald-500' : 'bg-stone-400'
        }`}
      />
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}
