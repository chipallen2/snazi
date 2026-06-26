import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/currentUser'
import { rotateToken } from './actions'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const user = await currentUser()
  if (!user) redirect('/login?next=/account')

  const configExample = JSON.stringify(
    {
      apiUrl: 'https://snazi.dev',
      apiKey: user.read_token,
      channels: ['imessage'],
    },
    null,
    2
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
          Account
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Signed in as <span className="font-medium text-neutral-700">{user.email}</span>.
        </p>
      </div>

      <section className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">CLI read token</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Paste this into <code className="rounded bg-neutral-100 px-1">~/.snazi/config.json</code>{' '}
            as <code className="rounded bg-neutral-100 px-1">apiKey</code>. It is{' '}
            <strong>read-only</strong>: it lets the agent check who messaged you and read
            approved messages, but it can never approve a sender. Keep it secret —
            anyone with it can see your approved senders and read approved message text.
          </p>
        </div>

        <code className="block break-all rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 font-mono text-xs text-neutral-800">
          {user.read_token}
        </code>

        <div className="flex flex-wrap items-center gap-3">
          <form action={rotateToken}>
            <button
              type="submit"
              className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Rotate token
            </button>
          </form>
          <p className="text-xs text-neutral-400">
            Generates a new token and immediately disables the old one. You’ll
            need to update <code className="rounded bg-neutral-100 px-1">config.json</code>{' '}
            on every machine that uses it.
          </p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Example config.json
          </h3>
          <pre className="mt-1 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 font-mono text-xs text-neutral-800">
            {configExample}
          </pre>
        </div>
      </section>
    </div>
  )
}
