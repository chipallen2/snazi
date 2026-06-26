import Link from 'next/link'
import { login } from './actions'
import { PasswordInput } from '../password-input'

export const dynamic = 'force-dynamic'

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string }
}) {
  const failed = searchParams.error === '1'
  const rateLimited = searchParams.error === 'rate'
  const next = searchParams.next || '/'
  const signupHref =
    next !== '/' ? `/signup?next=${encodeURIComponent(next)}` : '/signup'

  return (
    <div className="container-app flex flex-1 items-center justify-center py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            Welcome back
          </h1>
          <p className="mt-1.5 text-sm text-stone-500">
            Sign in to manage who can reach your agent.
          </p>
        </div>

        <div className="card overflow-hidden">
          <form action={login} className="space-y-4 p-6">
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
              <span>Password</span>
              <div className="mt-2">
                <PasswordInput
                  name="password"
                  autoComplete="current-password"
                />
              </div>
            </label>

            {failed && (
              <p className="alert-error">Wrong email or password.</p>
            )}
            {rateLimited && (
              <p className="alert-error">
                Too many attempts. Please wait a few minutes and try again.
              </p>
            )}

            <button type="submit" className="btn-brand w-full">
              Sign in
            </button>
          </form>

          <div className="border-t border-stone-100 bg-stone-50/60 px-6 py-4 text-center text-sm text-stone-500">
            No account?{' '}
            <Link href={signupHref} className="link-quiet">
              Create one
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
