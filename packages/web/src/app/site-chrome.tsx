'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { logout } from './login/actions'

const REPO_URL = 'https://github.com/chipallen2/snazi'

/** GitHub repo link — standard octocat mark, opens in a new tab. */
function GitHubLink({ className = '' }: { className?: string }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View snazi on GitHub"
      title="View on GitHub"
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-ink ${className}`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
      <span className="hidden lg:inline">GitHub</span>
    </a>
  )
}

/** The snazi bouncer mark ("No messages for you"). */
export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <Image
      src="/snazi-logo-circle.png"
      alt="snazi"
      width={64}
      height={64}
      className={`shrink-0 rounded-full ${className}`}
    />
  )
}

function Wordmark({
  center = false,
  showTagline = true,
}: {
  center?: boolean
  showTagline?: boolean
}) {
  return (
    <Link
      href="/"
      className={`group flex items-center gap-2.5 ${center ? 'flex-col text-center sm:flex-row sm:text-left' : ''}`}
    >
      <Logo className="-my-1.5 h-12 w-12" />
      <span className="flex flex-col">
        <span className="text-lg font-extrabold leading-tight tracking-tight text-ink">
          Soup Nazi AI
        </span>
        {showTagline && (
          <span className="text-[11px] font-medium leading-tight text-stone-400">
            No messages for you.
          </span>
        )}
      </span>
    </Link>
  )
}

export function SiteHeader({ authed }: { authed: boolean }) {
  const pathname = usePathname() || '/'
  const isAuthPage =
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/decide')

  // Auth / decide pages: minimal, CENTERED brand. No nav clutter.
  if (isAuthPage) {
    return (
      <header className="border-b border-stone-200/70 bg-white/80 backdrop-blur">
        <div className="container-app flex items-center justify-center py-5">
          <Wordmark center />
        </div>
      </header>
    )
  }

  // Logged-out landing: marketing header with CTAs.
  if (!authed) {
    return (
      <header className="sticky top-0 z-30 border-b border-stone-200/70 bg-stone-50/80 backdrop-blur">
        <div className="container-wide flex items-center justify-between py-4">
          <Wordmark />
          <nav className="flex items-center gap-2 sm:gap-3">
            <GitHubLink />
            <Link href="/login" className="btn-ghost hidden sm:inline-flex">
              Sign in
            </Link>
            <Link href="/signup" className="btn-brand">
              Get started
            </Link>
          </nav>
        </div>
      </header>
    )
  }

  // Logged-in app shell.
  return <AppHeader pathname={pathname} />
}

function AppHeader({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false)
  const nav = [
    { href: '/', label: 'Senders' },
    { href: '/channels', label: 'Channels' },
    { href: '/account', label: 'Account' },
  ]
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)
  const linkCls = (href: string) =>
    `rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
      isActive(href)
        ? 'bg-stone-100 text-ink'
        : 'text-stone-500 hover:bg-stone-100 hover:text-ink'
    }`

  return (
    <header className="sticky top-0 z-30 border-b border-stone-200/70 bg-white/85 backdrop-blur">
      <div className="container-app flex items-center justify-between py-4">
        <Wordmark />
        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 sm:flex">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={linkCls(n.href)}>
              {n.label}
            </Link>
          ))}
          <GitHubLink />
          <form action={logout}>
            <button className="ml-1 rounded-lg px-3 py-1.5 text-sm font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-ink">
              Sign out
            </button>
          </form>
        </nav>
        {/* Mobile hamburger */}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-stone-200 text-ink sm:hidden"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
            {open ? (
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
      </div>
      {/* Mobile menu panel */}
      {open && (
        <div className="border-t border-stone-200/70 bg-white sm:hidden">
          <nav className="container-app flex flex-col py-2">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                  isActive(n.href)
                    ? 'bg-stone-100 text-ink'
                    : 'text-stone-600 hover:bg-stone-100'
                }`}
              >
                {n.label}
              </Link>
            ))}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm font-semibold text-stone-600 hover:bg-stone-100"
            >
              GitHub
            </a>
            <form action={logout}>
              <button className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-stone-600 hover:bg-stone-100">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      )}
    </header>
  )
}

export function SiteFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className="mt-auto border-t border-stone-200/70 bg-white">
      <div className="container-app flex flex-col items-center gap-2.5 py-6 text-center">
        <div className="flex items-center gap-2 text-stone-400">
          <Logo className="h-6 w-6" />
          <span className="text-sm font-bold text-stone-500">snazi</span>
        </div>
        <p className="text-xs font-medium text-stone-500">
          Short for{' '}
          <span className="font-bold text-stone-700">Soup Nazi AI</span>.
        </p>
        <p className="max-w-md text-xs leading-relaxed text-stone-500">
          A bouncer for your AI agent&apos;s inbox. snazi stores{' '}
          <span className="font-semibold text-stone-700">
            no messages and no message content
          </span>{' '}
          — it manages an approve / deny list only.
        </p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-500 transition-colors hover:text-ink"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          View on GitHub
        </a>
        <p className="text-[11px] text-stone-400">
          © {year} snazi · No messages for you.
        </p>
      </div>
    </footer>
  )
}
