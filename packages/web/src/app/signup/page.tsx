import Link from 'next/link'
import { signup } from '../login/actions'
import { PasswordInput } from '../password-input'

export const dynamic = 'force-dynamic'

export default function SignupPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string }
}) {
  const error = searchParams.error
  const rateLimited = searchParams.error === 'rate'
  const next = searchParams.next || '/'
  const loginHref =
    next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'

  return (
    <div className="container-app flex flex-1 items-center justify-center py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            Create your account
          </h1>
          <p className="mt-1.5 text-sm text-stone-500">
            Free. Your list is private to you — snazi stores no messages.
          </p>
        </div>

        <div className="card overflow-hidden">
          <form action={signup} className="space-y-4 p-6">
            <input type="hidden" name="next" value={next} />
            <label className="field-label">
              Email
              <input
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                className="input"
              />
            </label>
            <label className="field-label">
              <span>
                Password{' '}
                <span className="font-normal normal-case tracking-normal text-stone-400">
                  (min 8 characters)
                </span>
              </span>
              <div className="mt-2">
                <PasswordInput
                  name="password"
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
            </label>

            {rateLimited && (
              <p className="alert-error">
                Too many attempts. Please wait a few minutes and try again.
              </p>
            )}
            {error && !rateLimited && <p className="alert-error">{error}</p>}

            <button type="submit" className="btn-brand w-full">
              Create account
            </button>
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-stone-400">
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-emerald-600">
                <path
                  d="M5 13l4 4L19 7"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              No message content is ever stored.
            </p>
          </form>

          <div className="border-t border-stone-100 bg-stone-50/60 px-6 py-4 text-center text-sm text-stone-500">
            Already have an account?{' '}
            <Link href={loginHref} className="link-quiet">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
