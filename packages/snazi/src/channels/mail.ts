/**
 * Small, dependency-free helpers shared by the email channel adapters
 * (Gmail, Outlook): parsing sender addresses out of headers, turning HTML
 * bodies into readable text, and validating that an instance has the OAuth2
 * credentials it needs (without ever logging them).
 */
import type { ChannelAuth } from '../config'
import type { ChannelAvailability, ChannelContext } from './types'

/**
 * Extract a bare, lowercased email address from a `From`-style value such as
 * `"Jane Doe" <jane@example.com>` or `jane@example.com`. Returns '' if none.
 */
export function extractEmail(value: string | null | undefined): string {
  if (!value) return ''
  const angled = value.match(/<([^>]+)>/)
  const candidate = (angled ? angled[1] : value).trim()
  const m = candidate.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/)
  return m ? m[0].toLowerCase() : ''
}

/** Decode a handful of common HTML entities used in mail bodies. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

/**
 * Very small HTML -> text conversion: drop script/style, turn block tags into
 * newlines, strip remaining tags, decode entities, collapse blank runs. Good
 * enough to render an email body for a human/agent; not a full HTML parser.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(
        // <a ...href="url"...>text</a> -> [text](url), preserving link URLs.
        // Handles quoted/single-quoted hrefs, other attrs before/after href,
        // and multiline/nested anchor content.
        /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
        (match, _q, dq, sq, inner) => {
          const url = (dq ?? sq ?? '').trim()
          // Only preserve real web links; leave mailto:/tel:/etc. to be stripped.
          if (!/^https?:\/\//i.test(url)) {
            return inner
          }
          const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          return text ? `[${text}](${url})` : url
        }
      )
      .replace(/<br\s*\/?>(?=\s*\S)/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The OAuth2 fields every email adapter requires. */
export interface OAuthCreds {
  clientId: string
  clientSecret: string
  refreshToken: string
}

function missingFields(auth: ChannelAuth): string[] {
  const missing: string[] = []
  if (!auth.clientId) missing.push('clientId')
  if (!auth.clientSecret) missing.push('clientSecret')
  if (!auth.refreshToken) missing.push('refreshToken')
  return missing
}

/**
 * Availability for an OAuth email channel: available iff the instance has all
 * three OAuth2 fields. Cheap + offline (no network probe), so it stays fast and
 * unit-testable. `label` is the human channel-type name for the message.
 */
export function oauthAvailability(
  ctx: ChannelContext | undefined,
  label: string
): ChannelAvailability {
  const missing = missingFields(ctx?.auth ?? {})
  if (missing.length === 0) return { available: true }
  return {
    available: false,
    reason: `${label} channel '${ctx?.id ?? '?'}' is not configured (missing ${missing.join(', ')}).`,
    detail: `Add clientId, clientSecret, and refreshToken to this channel's "auth" in ~/.snazi/config.json.`,
  }
}

/** Pull validated OAuth creds out of a context, or throw a clear error. */
export function requireOAuth(ctx: ChannelContext, label: string): OAuthCreds {
  const auth = ctx.auth ?? {}
  const missing = missingFields(auth)
  if (missing.length > 0) {
    throw new Error(
      `${label} channel '${ctx.id}' is missing ${missing.join(', ')} in its auth config.`
    )
  }
  return {
    clientId: auth.clientId as string,
    clientSecret: auth.clientSecret as string,
    refreshToken: auth.refreshToken as string,
  }
}
