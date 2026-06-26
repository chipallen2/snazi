import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/currentUser'
import { rotateToken } from './actions'
import { TokenField } from './token-field'
import { CodeBlock } from './code-block'

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
    <div className="container-app max-w-2xl space-y-6 py-8 sm:py-10">
      <div>
        <span className="eyebrow">Account</span>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          Your agent&apos;s keys
        </h1>
        <p className="mt-1.5 text-sm text-stone-500">
          Signed in as{' '}
          <span className="font-semibold text-stone-700">{user.email}</span>.
        </p>
      </div>

      <section className="card-pad space-y-4">
        <div>
          <h2 className="text-base font-bold text-ink">CLI read token</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone-500">
            Paste this into{' '}
            <code className="rounded bg-stone-100 px-1 font-mono text-[0.8em]">
              ~/.snazi/config.json
            </code>{' '}
            as{' '}
            <code className="rounded bg-stone-100 px-1 font-mono text-[0.8em]">
              apiKey
            </code>
            . It is <strong className="text-stone-700">read-only</strong>: it
            lets the agent check who messaged you and read approved messages,
            but it can never approve a sender.
          </p>
        </div>

        <TokenField token={user.read_token} />

        <p className="flex items-start gap-1.5 text-xs text-stone-400">
          <span className="text-amber-500">⚠</span>
          Keep it secret — anyone with it can see your approved senders and
          read approved message text.
        </p>

        <div className="flex flex-col gap-2 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:gap-3">
          <form action={rotateToken} className="shrink-0">
            <button type="submit" className="btn-outline whitespace-nowrap">
              Rotate token
            </button>
          </form>
          <p className="text-xs text-stone-400">
            Generates a new token and immediately disables the old one. Update{' '}
            <code className="rounded bg-stone-100 px-1 font-mono text-[0.8em]">
              config.json
            </code>{' '}
            on every machine that uses it.
          </p>
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">
            Example config.json
          </h3>
          <div className="mt-1.5">
            <CodeBlock code={configExample} />
          </div>
        </div>
      </section>
    </div>
  )
}
