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
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Channels</h1>
        <p className="text-sm text-neutral-500">
          Communication channels gated by the approve/deny list. Read-only.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr
                key={c.id}
                className="border-b border-neutral-100 last:border-0"
              >
                <td className="px-4 py-3 font-mono">{c.id}</td>
                <td className="px-4 py-3">{c.display_name}</td>
                <td className="px-4 py-3 text-neutral-500">
                  {c.description || '—'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      c.enabled
                        ? 'bg-green-100 text-green-800'
                        : 'bg-neutral-200 text-neutral-600'
                    }`}
                  >
                    {c.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
