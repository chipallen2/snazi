import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'soup-nazi · sender list',
  description: 'No messages for you. Approve/deny list manager.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-lg font-bold tracking-tight">
                soup-nazi
              </span>
              <span className="text-sm text-neutral-400">
                No messages for you.
              </span>
            </Link>
            <nav className="flex gap-4 text-sm font-medium text-neutral-500">
              <Link href="/" className="hover:text-neutral-900">
                Senders
              </Link>
              <Link href="/channels" className="hover:text-neutral-900">
                Channels
              </Link>
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
