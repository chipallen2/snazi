import Link from 'next/link'
import { signup } from '../login/actions'

export const dynamic = 'force-dynamic'

export default function SignupPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string }
}) {
  const error = searchParams.error
  const rateLimited = searchParams.error === 'rate'
  const next = searchParams.next || '/'
  const loginHref = next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'

  return (
    <div className="mx-auto max-w-sm">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-6 pb-5 pt-6">
          <h1 className="text-lg font-bold tracking-tight text-neutral-900">
            Create account
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Free. Your list is private to you. This service stores no messages.
          </p>
        </div>

        <form action={signup} className="space-y-4 px-6 py-6">
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
            Password <span className="text-neutral-400">(min 8 characters)</span>
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
            />
          </label>

          {rateLimited && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              Too many attempts. Please wait a few minutes and try again.
            </p>
          )}
          {error && !rateLimited && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
          >
            Create account
          </button>
        </form>

        <div className="border-t border-neutral-100 px-6 py-4 text-center text-sm text-neutral-500">
          Already have an account?{' '}
          <Link href={loginHref} className="font-medium text-neutral-900 hover:underline">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  )
}
