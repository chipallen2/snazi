import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import './globals.css'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { logout } from './login/actions'

export const metadata: Metadata = {
  title: 'Soup Nazi AI · sender list',
  description: 'No messages for you. Approve/deny list manager.',
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const authed = Boolean(
    await verifySessionToken(cookies().get(SESSION_COOKIE)?.value)
  )
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="whitespace-nowrap text-lg font-bold tracking-tight">
                Soup Nazi AI
              </span>
              <span className="hidden text-sm text-neutral-400 sm:inline">
                No messages for you.
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm font-medium text-neutral-500">
              {authed && (
                <>
                  <Link href="/" className="hover:text-neutral-900">
                    Senders
                  </Link>
                  <Link href="/channels" className="hover:text-neutral-900">
                    Channels
                  </Link>
                  <Link href="/account" className="hover:text-neutral-900">
                    Account
                  </Link>
                  <form action={logout}>
                    <button className="hover:text-neutral-900">Sign out</button>
                  </form>
                </>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
        <footer className="mx-auto max-w-4xl px-6 py-8 text-xs text-neutral-400">
          This service stores no messages and no message content. It manages an
          approve/deny list only.
        </footer>
      </body>
    </html>
  )
}
