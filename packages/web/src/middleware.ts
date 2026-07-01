import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionToken, verifyDecide } from '@/lib/session'
import { normalizeAddress } from '@/lib/address'

/**
 * Dashboard gate.
 *
 *   - Every page requires a valid session cookie (set after a correct
 *     email + password login at /login).
 *   - /login and /signup are always reachable (and bounce to / if authed).
 *   - /decide is reachable WITHOUT a session if it carries a valid, unexpired
 *     HMAC signature bound to the link's owner — that's the capability-link
 *     path the agent sends to the account owner.
 *
 * /api/* is intentionally NOT matched here: those routes carry their own
 * per-user token auth and are called by the CLI without a browser session.
 */
export async function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const hasSession = Boolean(await verifySessionToken(token))

  if (pathname === '/login' || pathname === '/signup') {
    if (hasSession) return NextResponse.redirect(new URL('/', req.url))
    return NextResponse.next()
  }

  // Public marketing landing lives at '/'. Logged-out visitors see the
  // landing page (rendered by app/page.tsx); logged-in users see their
  // dashboard. Either way the route is reachable without a session.
  if (pathname === '/') {
    return NextResponse.next()
  }

  if (pathname === '/decide') {
    if (hasSession) return NextResponse.next()
    // Success state after a decide action — no auth needed, just show result.
    const done = searchParams.get('done')
    if (done === 'allow' || done === 'block') return NextResponse.next()
    // Shortcode form (`/decide?s=<code>`): the code is an opaque handle whose
    // signed fields live server-side, so we can't HMAC-verify it at the edge
    // without a DB lookup. Defer to the page, which resolves the code and
    // re-verifies the stored signature (showing a friendly dead-end for a
    // missing/expired/forged code). A bare, unresolvable code renders no
    // working form, so passing it through leaks nothing.
    const shortcode = (searchParams.get('s') || '').trim()
    if (shortcode) return NextResponse.next()
    const owner = (searchParams.get('owner') || '').trim()
    const channel = (searchParams.get('channel') || 'imessage').trim() || 'imessage'
    const sender = normalizeAddress(searchParams.get('sender'))
    const exp = Number(searchParams.get('exp'))
    const sig = searchParams.get('sig')
    if (owner && sender && (await verifyDecide(owner, channel, sender, exp, sig))) {
      return NextResponse.next()
    }
    return redirectToLogin(req, pathname + req.nextUrl.search)
  }

  if (!hasSession) {
    return redirectToLogin(req, pathname + req.nextUrl.search)
  }
  return NextResponse.next()
}

function redirectToLogin(req: NextRequest, next: string): NextResponse {
  const url = new URL('/login', req.url)
  if (next && next.startsWith('/')) url.searchParams.set('next', next)
  return NextResponse.redirect(url)
}

export const config = {
  // Match everything EXCEPT API routes, Next internals, and static assets.
  // The trailing extension group keeps public files (logos) and the app-router
  // icon routes (/icon.png, /apple-icon.png, favicon.ico) from being redirected
  // to /login — which would 307 them and break <img>/next-image (the optimizer
  // then 400s on the redirected source).
  matcher: [
    '/((?!api|_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|json|webmanifest)$).*)',
  ],
}
