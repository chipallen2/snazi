import { getSupabase } from '@/lib/supabase'
import type { Channel, Sender } from '@/lib/types'
import { addSender, setStatus, removeSender } from './actions'

export const dynamic = 'force-dynamic'

async function loadData(): Promise<{ channels: Channel[]; senders: Sender[] }> {
  const supabase = getSupabase()
  const [{ data: channels }, { data: senders }] = await Promise.all([
    supabase.from('sna_channels').select('*').order('id'),
    supabase
      .from('sna_senders')
      .select('*')
      .order('decided_at', { ascending: false }),
  ])
  return {
    channels: (channels as Channel[]) ?? [],
    senders: (senders as Sender[]) ?? [],
  }
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === 'approved'
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
      }`}
    >
      {status}
    </span>
  )
}

export default async function Home() {
  const { channels, senders } = await loadData()

  const byChannel = new Map<string, Sender[]>()
  for (const s of senders) {
    const arr = byChannel.get(s.channel_id) ?? []
    arr.push(s)
    byChannel.set(s.channel_id, arr)
  }

  return (
    <div className="space-y-8">
      {/* Add sender form */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Add / update sender
        </h2>
        <form
          action={addSender}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Channel
            <select
              name="channel_id"
              required
              defaultValue={channels[0]?.id ?? 'imessage'}
              className="mt-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Address (phone / email)
            <input
              name="sender_address"
              required
              placeholder="+15551234567"
              className="mt-1 w-56 rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Label (optional)
            <input
              name="label"
              placeholder="Mom"
              className="mt-1 w-40 rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Status
            <select
              name="status"
              defaultValue="approved"
              className="mt-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
            >
              <option value="approved">approved</option>
              <option value="denied">denied</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
          >
            Save
          </button>
        </form>
      </section>

      {/* Senders grouped by channel */}
      {channels.map((channel) => {
        const list = byChannel.get(channel.id) ?? []
        return (
          <section key={channel.id} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold">{channel.display_name}</h2>
              <span className="text-xs text-neutral-400">
                {list.length} sender{list.length === 1 ? '' : 's'}
              </span>
            </div>

            {list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 bg-white px-4 py-6 text-sm text-neutral-400">
                No senders in this channel yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                      <th className="px-4 py-3 font-medium">Address</th>
                      <th className="px-4 py-3 font-medium">Label</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr
                        key={s.id}
                        className="border-b border-neutral-100 last:border-0"
                      >
                        <td className="px-4 py-3 font-mono text-neutral-900">
                          {s.sender_address}
                        </td>
                        <td className="px-4 py-3 text-neutral-500">
                          {s.label || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={s.status} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <form
                              action={setStatus.bind(
                                null,
                                s.channel_id,
                                s.sender_address,
                                'approved'
                              )}
                            >
                              <button
                                disabled={s.status === 'approved'}
                                className="rounded-md border border-green-300 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-30"
                              >
                                Approve
                              </button>
                            </form>
                            <form
                              action={setStatus.bind(
                                null,
                                s.channel_id,
                                s.sender_address,
                                'denied'
                              )}
                            >
                              <button
                                disabled={s.status === 'denied'}
                                className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-30"
                              >
                                Deny
                              </button>
                            </form>
                            <form
                              action={removeSender.bind(
                                null,
                                s.channel_id,
                                s.sender_address
                              )}
                            >
                              <button className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
                                Remove
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
