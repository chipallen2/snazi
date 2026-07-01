import Link from 'next/link'
import { currentUserId } from '@/lib/currentUser'
import { getSenderExact, getChannelBySlug, resolveDecideShortcode } from '@/lib/data'
import type { CheckStatus } from '@/lib/types'
import { normalizeAddress, extractEmailDomain, domainWildcard } from '@/lib/address'
import { resolveDecideOwner } from '@/lib/session'
import { decideStatus, decideDomainStatus } from '../actions'
import { CloseButton } from './CloseButton'

export const dynamic = 'force-dynamic'

async function lookup(
  owner: string,
  channel: string,
  sender: string,
  domain: string | null
): Promise<{
  status: CheckStatus
  label: string | null
  channelName: string
  domainStatus: CheckStatus
}> {
  // Look up the EXACT sender row (no wildcard fallback) so the per-sender pill
  // reflects the individual decision, and SEPARATELY the domain wildcard's own
  // status, so the page can show both scopes independently.
  const [existing, channelRow, wildcardRow] = await Promise.all([
    getSenderExact(owner, channel, sender),
    getChannelBySlug(owner, channel),
    domain
      ? getSenderExact(owner, channel, domainWildcard(domain))
      : Promise.resolve(null),
  ])
  return {
    status: (existing?.status as CheckStatus) ?? 'unknown',
    label: existing?.label ?? null,
    channelName: channelRow?.name ?? channel,
    domainStatus: (wildcardRow?.status as CheckStatus) ?? 'unknown',
  }
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 text-sm font-semibold text-stone-400 hover:text-stone-700"
    >
      ← All senders
    </Link>
  )
}

function StatusPill({ status }: { status: CheckStatus }) {
  const map = {
    approved: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Currently allowed' },
    denied: { dot: 'bg-red-500', text: 'text-red-700', label: 'Currently blocked' },
    unknown: { dot: 'bg-stone-300', text: 'text-stone-500', label: 'Not decided yet' },
  }[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${map.text}`}>
      <span className={`h-2 w-2 rounded-full ${map.dot}`} />
      {map.label}
    </span>
  )
}

export default async function Decide({
  searchParams,
}: {
  searchParams: {
    owner?: string
    channel?: string
    sender?: string
    label?: string
    exp?: string
    sig?: string
    done?: string
    name?: string
    s?: string
  }
}) {
  // ── Success state ────────────────────────────────────────────────────────
  if (searchParams.done === 'allow' || searchParams.done === 'block') {
    const allowed = searchParams.done === 'allow'
    const sessionUserId = await currentUserId()
    return (
      <div className="container-app flex flex-1 flex-col items-center justify-center space-y-8 py-12">
        <div className="flex flex-col items-center gap-4">
          <p
            className={`text-4xl font-extrabold tracking-widest ${
              allowed ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {allowed ? 'ALLOWED' : 'BLOCKED'}
          </p>
          {allowed ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-24 w-24 text-emerald-500"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-24 w-24 text-red-500"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>
        <CloseButton />
        {sessionUserId && (
          <Link
            href="/"
            className="text-sm font-semibold text-stone-400 hover:text-stone-700"
          >
            ← All senders
          </Link>
        )}
      </div>
    )
  }

  // ── Shortcode resolution ──────────────────────────────────────────────────
  // `/decide?s=<code>` is the compact form of a signed link. When present (and
  // the inline fields are absent), resolve the code back to the SAME owner /
  // channel / sender / exp / sig the long URL would have carried, then proceed
  // identically. A missing/expired code shows a friendly dead-end.
  const shortcode = (searchParams.s || '').trim()
  const usingShortcode =
    !!shortcode &&
    !searchParams.sender &&
    !searchParams.owner &&
    !searchParams.sig
  let resolved = searchParams
  if (usingShortcode) {
    const row = await resolveDecideShortcode(shortcode)
    if (!row) {
      return (
        <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
          <div className="card w-full max-w-md p-6 text-center">
            <h1 className="text-lg font-bold text-ink">Link not found or expired</h1>
            <p className="mt-2 text-sm text-stone-500">
              This one-tap link is no longer valid. Ask for a fresh link, or sign
              in to manage who can reach your agent.
            </p>
          </div>
          <Link
            href="/login"
            className="inline-flex items-center gap-1 text-sm font-semibold text-stone-400 hover:text-stone-700"
          >
            Sign in →
          </Link>
        </div>
      )
    }
    resolved = {
      ...searchParams,
      owner: row.owner_id,
      channel: row.channel,
      sender: row.sender,
      label: row.label ?? undefined,
      exp: String(row.exp),
      sig: row.sig,
    }
  }

  const channel = (resolved.channel || 'imessage').trim() || 'imessage'
  const sender = normalizeAddress(resolved.sender || '')
  const passedLabel = (resolved.label || '').trim()
  // Capability-link proof, threaded through so the POST action can re-verify
  // it (server actions are independently POST-able and must not trust the page
  // gate alone).
  const exp = resolved.exp || ''
  const sig = resolved.sig || ''
  // Owner resolution is shared with the POST action (resolveDecideOwner): a
  // valid signed link wins (it carries its own owner), else the logged-in
  // session user. This guarantees the form we render writes to the SAME tenant
  // the action will authorize — a logged-in user tapping someone else's signed
  // link decides for the LINK's owner, never silently for their own list.
  const sessionUserId = await currentUserId()
  const owner =
    (await resolveDecideOwner({
      ownerParam: resolved.owner,
      channel,
      sender,
      exp: Number(exp),
      sig,
      sessionUserId,
    })) || ''

  // No sender → friendly guidance, link home.
  if (!sender) {
    return (
      <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
        <div className="card w-full max-w-md p-6 text-center">
          <h1 className="text-lg font-bold text-ink">Nothing to decide</h1>
          <p className="mt-2 text-sm text-stone-500">
            This link is missing a sender, so there’s no one to allow or block.
          </p>
        </div>
        <BackLink />
      </div>
    )
  }

  // No resolvable owner → the link is expired/invalid and there's no session.
  // (Middleware normally blocks this; guard anyway so we never query with an
  // empty owner.) Point them at sign-in rather than erroring.
  if (!owner) {
    return (
      <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
        <div className="card w-full max-w-md p-6 text-center">
          <h1 className="text-lg font-bold text-ink">Link expired</h1>
          <p className="mt-2 text-sm text-stone-500">
            This one-tap link is no longer valid. Sign in to manage who can reach
            your agent.
          </p>
        </div>
        <Link
          href="/login"
          className="inline-flex items-center gap-1 text-sm font-semibold text-stone-400 hover:text-stone-700"
        >
          Sign in →
        </Link>
      </div>
    )
  }

  // Domain wildcard is only meaningful for emails (phones have no domain).
  const domain = extractEmailDomain(sender)
  const { status, label, channelName, domainStatus } = await lookup(
    owner,
    channel,
    sender,
    domain
  )
  const displayLabel = label || passedLabel
  const primary = displayLabel || sender
  const sub = displayLabel ? sender : null
  // A signed /decide link (or a session) already proves authority to decide for
  // this owner + domain, so a resolvable owner is all that's needed to offer a
  // domain-wide Allow. (Mirrors the server-side authorization in
  // decideDomainStatus.)
  const canAllowDomain = !!owner

  return (
    <div className="container-app flex flex-1 flex-col items-center justify-center space-y-5 py-12">
      <div className="card w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="border-b border-stone-100 px-6 pb-5 pt-6">
          <p className="eyebrow">Should your agent read messages from</p>
          <h1 className="mt-2 break-words text-2xl font-extrabold tracking-tight text-ink">
            {primary}
          </h1>
          {sub && (
            <p className="mt-1 break-all font-mono text-sm text-stone-500">{sub}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              {channelName}
            </span>
            <StatusPill status={status} />
          </div>
        </div>

        {/* Decision buttons (always shown so the user can change their mind) */}
        <div className="space-y-3 px-6 py-6">
          <form action={decideStatus}>
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="channel_id" value={channel} />
            <input type="hidden" name="sender_address" value={sender} />
            <input type="hidden" name="label" value={displayLabel} />
            <input type="hidden" name="exp" value={exp} />
            <input type="hidden" name="sig" value={sig} />
            <input type="hidden" name="status" value="approved" />
            <button
              type="submit"
              className="btn-allow btn-lg w-full py-4"
            >
              Allow
            </button>
          </form>

          <form action={decideStatus}>
            <input type="hidden" name="owner" value={owner} />
            <input type="hidden" name="channel_id" value={channel} />
            <input type="hidden" name="sender_address" value={sender} />
            <input type="hidden" name="label" value={displayLabel} />
            <input type="hidden" name="exp" value={exp} />
            <input type="hidden" name="sig" value={sig} />
            <input type="hidden" name="status" value="denied" />
            <button
              type="submit"
              className="btn btn-lg w-full bg-red-600 py-4 text-white shadow-sm hover:bg-red-700 active:bg-red-800"
            >
              Block
            </button>
          </form>

          <p className="pt-1 text-center text-xs text-stone-400">
            Allow lets your agent read &amp; summarize their messages. Block (or
            no decision) means their messages stay private.
          </p>
        </div>

        {/* Domain-wide section (emails only) ------------------------------- */}
        {domain && (
          <div className="border-t border-stone-100 bg-stone-50/60 px-6 py-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Everyone @{domain}
              </p>
              <StatusPill status={domainStatus} />
            </div>
            <p className="mt-1 text-xs text-stone-400">
              Apply one decision to <span className="font-medium">all</span>{' '}
              senders from this domain. A decision on the individual address
              above always overrides this.
            </p>
            <div
              className={`mt-3 grid gap-2 ${
                canAllowDomain ? 'grid-cols-2' : 'grid-cols-1'
              }`}
            >
              {/* A valid signed link (or session) resolves an owner, which is
                  all that's required to offer domain-wide Allow or Block. */}
              {canAllowDomain && (
                <form action={decideDomainStatus}>
                  <input type="hidden" name="owner" value={owner} />
                  <input type="hidden" name="channel_id" value={channel} />
                  <input type="hidden" name="original_sender" value={sender} />
                  <input type="hidden" name="domain" value={domain} />
                  <input type="hidden" name="exp" value={exp} />
                  <input type="hidden" name="sig" value={sig} />
                  <input type="hidden" name="status" value="approved" />
                  <button
                    type="submit"
                    className="btn w-full border border-emerald-200 bg-white py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100"
                  >
                    Allow whole domain
                  </button>
                </form>
              )}
              <form action={decideDomainStatus}>
                <input type="hidden" name="owner" value={owner} />
                <input type="hidden" name="channel_id" value={channel} />
                <input type="hidden" name="original_sender" value={sender} />
                <input type="hidden" name="domain" value={domain} />
                <input type="hidden" name="exp" value={exp} />
                <input type="hidden" name="sig" value={sig} />
                <input type="hidden" name="status" value="denied" />
                <button
                  type="submit"
                  className="btn w-full border border-red-200 bg-white py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 active:bg-red-100"
                >
                  Block whole domain
                </button>
              </form>
            </div>
          </div>
        )}
      </div>

      <BackLink />
    </div>
  )
}
