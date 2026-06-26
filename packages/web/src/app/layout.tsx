import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'
import { SiteHeader, SiteFooter } from './site-chrome'

export const metadata: Metadata = {
  title: 'snazi · No messages for you',
  description:
    'A bouncer for your AI agent’s inbox. snazi gates who can reach your assistant — approve the people you trust, ignore everyone else. Stores no message content.',
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
      <body className="flex min-h-screen flex-col">
        <SiteHeader authed={authed} />
        <main className="flex flex-1 flex-col">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
