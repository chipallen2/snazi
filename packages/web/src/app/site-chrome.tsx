'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { logout } from './login/actions'

/** The "No messages for you" mark — a no-entry sign in brand gold. */
export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-xl bg-ink ${className}`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" fill="none" className="h-[62%] w-[62%]">
        <circle cx="12" cy="12" r="9" stroke="#f98906" strokeWidth="2.5" />
        <line
          x1="5.6"
          y1="5.6"
          x2="18.4"
          y2="18.4"
          stroke="#f98906"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
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
      <Logo />
      <span className="flex flex-col">
        <span className="text-lg font-extrabold leading-tight tracking-tight text-ink">
          snazi
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
        <p className="max-w-md text-xs leading-relaxed text-stone-500">
          A bouncer for your AI agent&apos;s inbox. snazi stores{' '}
          <span className="font-semibold text-stone-700">
            no messages and no message content
          </span>{' '}
          — it manages an approve / deny list only.
        </p>
        <p className="text-[11px] text-stone-400">
          © {year} snazi · No messages for you.
        </p>
      </div>
    </footer>
  )
}
