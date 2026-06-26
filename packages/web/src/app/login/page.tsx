import Link from 'next/link'
import { login } from './actions'

export const dynamic = 'force-dynamic'

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string }
}) {
  const failed = searchParams.error === '1'
  const rateLimited = searchParams.error === 'rate'
  const next = searchParams.next || '/'
  const signupHref = next !== '/' ? `/signup?next=${encodeURIComponent(next)}` : '/signup'

  return (
    <div className="mx-auto max-w-sm">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-6 pb-5 pt-6">
          <h1 className="text-lg font-bold tracking-tight text-neutral-900">
            Sign in
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Manage who can reach your agent.
          </p>
        </div>

        <form action={login} className="space-y-4 px-6 py-6">
          <input type="hidden" name="next" value={next} />
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Email
            <input
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-neutral-600">
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>

          {failed && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              Wrong email or password.
            </p>
          )}
          {rateLimited && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              Too many attempts. Please wait a few minutes and try again.
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-black"
          >
            Sign in
          </button>
        </form>

        <div className="border-t border-neutral-100 px-6 py-4 text-center text-sm text-neutral-500">
          No account?{' '}
          <Link href={signupHref} className="font-medium text-neutral-900 hover:underline">
            Create one
          </Link>
        </div>
      </div>
    </div>
  )
}
