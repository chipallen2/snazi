/**
 * Owner-scoped data access for the approve/deny list.
 *
 * THIS IS THE TENANT-ISOLATION CHOKE POINT. Every function REQUIRES an
 * ownerId and applies `.eq('owner_id', ownerId)` to every query. No other
 * module should query sna_senders directly — route everything through here so
 * a forgotten owner filter can never leak one tenant's list to another.
 */
import { getSupabase } from './supabase'
import { senderMatchCandidates, pickMostSpecific } from './match'
import type { Action, ActionStatus, Channel, ChannelType, CheckStatus, Sender, SenderStatus } from './types'

/**
 * Thrown when a shortcode INSERT hits the primary-key unique constraint (two
 * random codes collided). Callers catch this specifically to retry with a
 * freshly generated code, rather than surfacing a 500 for a benign collision.
 */
export class ShortcodeCollisionError extends Error {
  constructor(message = 'Shortcode already exists.') {
    super(message)
    this.name = 'ShortcodeCollisionError'
  }
}

function assertOwner(ownerId: string): void {
  if (!ownerId || typeof ownerId !== 'string') {
    throw new Error('ownerId is required for every sender query.')
  }
}

/**
 * Defense-in-depth backstop for tenant isolation. Isolation is enforced by the
 * `.eq('owner_id', ownerId)` filter on every query, but the service-role key
 * bypasses RLS, so a future edit that drops a filter would silently leak across
 * tenants with no database-level guard. Re-verifying owner_id on the way OUT
 * turns that class of bug into a hard error instead of a cross-tenant read.
 */
function assertRowOwned(
  row: { owner_id?: string } | null | undefined,
  ownerId: string
): void {
  if (row && row.owner_id !== undefined && row.owner_id !== ownerId) {
    throw new Error('Tenant isolation violation: row owner_id does not match.')
  }
}

// ---------------------------------------------------------------------------
// Channel TYPES (global registry) + channel INSTANCES (per-user, owner-scoped).
// ---------------------------------------------------------------------------

/** Every enabled channel TYPE (global reference data). */
export async function listChannelTypes(): Promise<ChannelType[]> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_channel_types')
    .select('*')
    .eq('enabled', true)
    .order('id')
  if (error) throw new Error(error.message)
  return (data as ChannelType[]) ?? []
}

/** All channel instances for one owner (their named "channels"). */
export async function listChannels(ownerId: string): Promise<Channel[]> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_channels')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data as Channel[]) ?? []
  for (const row of rows) assertRowOwned(row, ownerId)
  return rows
}

/** One channel instance for one owner by slug, or null. */
export async function getChannelBySlug(
  ownerId: string,
  slug: string
): Promise<Channel | null> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_channels')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(error.message)
  assertRowOwned(data as { owner_id?: string } | null, ownerId)
  return (data as Channel) ?? null
}

/** Turn a free-text name into a slug-safe token (a-z0-9 plus dashes). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Validate an explicit slug. It must match the CLI's channel-id charset
 * ([a-z0-9_-]) so the gate keys line up exactly between dashboard and CLI.
 */
function validateSlug(input: string): string {
  const v = input.trim().toLowerCase()
  if (!/^[a-z0-9_-]{1,48}$/.test(v)) {
    throw new Error(
      'Slug may contain only lowercase letters, numbers, dashes, and underscores (max 48).'
    )
  }
  return v
}

/**
 * Create a channel instance for one owner.
 *
 * The slug is what the CLI passes as `--channel` and what the approve/deny gate
 * keys on, so callers may set it EXPLICITLY (to match an existing CLI channel
 * id). If omitted it is derived from the name and made unique per owner. NO
 * credentials are stored here — those live only on the CLI machine.
 */
export async function createChannel(
  ownerId: string,
  input: { type: string; name: string; slug?: string }
): Promise<Channel> {
  assertOwner(ownerId)
  const type = input.type.trim()
  const name = input.name.trim()
  if (!type) throw new Error('A channel type is required.')
  if (!name) throw new Error('A channel name is required.')

  // Validate the type exists/enabled so we never create a dangling instance.
  const types = await listChannelTypes()
  if (!types.some((t) => t.id === type)) {
    throw new Error(`Unknown channel type '${type}'.`)
  }

  const existing = await listChannels(ownerId)
  const taken = new Set(existing.map((c) => c.slug))

  let slug: string
  if (input.slug && input.slug.trim()) {
    // Explicit slug: validate + enforce uniqueness with a clear error.
    slug = validateSlug(input.slug)
    if (taken.has(slug)) {
      throw new Error(`A channel with slug '${slug}' already exists.`)
    }
  } else {
    // Auto-derive: name → slug, then type-qualify / number to stay unique.
    const base = slugify(name) || type
    slug = base
    if (taken.has(slug)) slug = `${type}-${base}`
    let n = 2
    while (taken.has(slug)) {
      slug = `${base}-${n}`
      n += 1
    }
  }

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_channels')
    .insert({ owner_id: ownerId, type, name, slug })
    .select()
    .single()
  if (error) throw new Error(error.message)
  assertRowOwned(data as { owner_id?: string } | null, ownerId)
  return data as Channel
}

/**
 * Delete a channel instance (by slug) for one owner, along with every sender on
 * that channel's list (they reference the slug). Owner-scoped on both deletes.
 */
export async function deleteChannel(ownerId: string, slug: string): Promise<void> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { error: sendersError } = await supabase
    .from('sna_senders')
    .delete()
    .eq('owner_id', ownerId)
    .eq('channel_id', slug)
  if (sendersError) throw new Error(sendersError.message)
  const { error } = await supabase
    .from('sna_channels')
    .delete()
    .eq('owner_id', ownerId)
    .eq('slug', slug)
  if (error) throw new Error(error.message)
}

/** Full list for one owner, optionally filtered by channel. */
export async function listSenders(
  ownerId: string,
  channel?: string
): Promise<Sender[]> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  let query = supabase
    .from('sna_senders')
    .select('*')
    .eq('owner_id', ownerId)
    .order('decided_at', { ascending: false })
  if (channel) query = query.eq('channel_id', channel)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const rows = (data as Sender[]) ?? []
  for (const row of rows) assertRowOwned(row, ownerId)
  return rows
}

/**
 * A single sender's approval status for one owner.
 *
 * Two-step lookup: an EXACT sender_address match always wins; if there is no
 * exact row and the address is an email, fall back to a domain wildcard
 * (`*@domain`). This lets an owner approve/deny a whole domain at once while
 * still letting a per-sender decision override it (e.g. block *@google.com but
 * allow one trusted person@google.com).
 */
export async function checkSender(
  ownerId: string,
  channel: string,
  address: string
): Promise<CheckStatus> {
  assertOwner(ownerId)
  const supabase = getSupabase()

  // Candidate addresses, most specific first: exact sender + (for emails) its
  // subdomain wildcard + its root-domain wildcard (covers all subdomains).
  const candidates = senderMatchCandidates(address)

  const { data, error } = await supabase
    .from('sna_senders')
    .select('status,sender_address,owner_id')
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .in('sender_address', candidates)
  if (error) throw new Error(error.message)

  const rows =
    (data as { status: string; sender_address: string; owner_id: string }[]) ?? []
  for (const row of rows) assertRowOwned(row, ownerId)

  // Most specific existing decision wins: exact > subdomain > root wildcard.
  const match = pickMostSpecific(candidates, rows)
  return (match?.status as CheckStatus) ?? 'unknown'
}

/**
 * Fetch one full sender row for one owner (or null).
 *
 * Mirrors checkSender's precedence: returns the EXACT row when present,
 * otherwise (for emails) the domain-wildcard row, otherwise null. Callers use
 * this to render status; keeping the precedence identical to checkSender means
 * the dashboard/decide UI can never disagree with the gate.
 */
export async function getSender(
  ownerId: string,
  channel: string,
  address: string
): Promise<Sender | null> {
  assertOwner(ownerId)
  const supabase = getSupabase()

  const candidates = senderMatchCandidates(address)

  const { data, error } = await supabase
    .from('sna_senders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .in('sender_address', candidates)
  if (error) throw new Error(error.message)

  const rows = (data as Sender[]) ?? []
  for (const row of rows) assertRowOwned(row, ownerId)

  // Most specific existing row wins: exact > subdomain > root wildcard.
  return pickMostSpecific(candidates, rows)
}

/**
 * Fetch the EXACT sender row for one owner (no domain-wildcard fallback).
 * Used where the UI needs the literal row for a specific address — e.g. to show
 * the domain wildcard's OWN status independently of any per-sender row.
 */
export async function getSenderExact(
  ownerId: string,
  channel: string,
  address: string
): Promise<Sender | null> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_senders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .eq('sender_address', address)
    .maybeSingle()
  if (error) throw new Error(error.message)
  assertRowOwned(data as { owner_id?: string } | null, ownerId)
  return (data as Sender) ?? null
}

/**
 * Upsert a sender to approved/denied for one owner.
 *
 * `label` is optional: omit it to leave an existing display name untouched
 * (status-only toggles on the dashboard must not wipe labels).
 */
export async function upsertSender(
  ownerId: string,
  input: {
    channel_id: string
    sender_address: string
    label?: string | null
    status: SenderStatus
    decided_by?: string
  }
): Promise<Sender> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const row: Record<string, unknown> = {
    owner_id: ownerId,
    channel_id: input.channel_id,
    sender_address: input.sender_address,
    status: input.status,
    decided_at: new Date().toISOString(),
    decided_by: input.decided_by ?? 'dashboard',
  }
  if (input.label !== undefined) {
    row.label = input.label
  }
  const { data, error } = await supabase
    .from('sna_senders')
    .upsert(row, { onConflict: 'owner_id,channel_id,sender_address' })
    .select()
    .single()
  if (error) throw new Error(error.message)
  assertRowOwned(data as { owner_id?: string } | null, ownerId)
  return data as Sender
}

/** Remove a sender from one owner's list entirely (status → unknown). */
export async function deleteSender(
  ownerId: string,
  channel: string,
  address: string
): Promise<void> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { error } = await supabase
    .from('sna_senders')
    .delete()
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .eq('sender_address', address)
  if (error) throw new Error(error.message)
}

/**
 * UPDATE-ONLY label change for one owner. Never inserts, never touches status,
 * so it can never create a row or open the gate. Returns the updated row, or
 * null if the sender isn't on this owner's list yet.
 */
export async function updateLabel(
  ownerId: string,
  channel: string,
  address: string,
  label: string
): Promise<Sender | null> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_senders')
    .update({ label })
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .eq('sender_address', address)
    .select()
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return null
  assertRowOwned(data[0] as { owner_id?: string } | null, ownerId)
  return data[0] as Sender
}

// ---------------------------------------------------------------------------
// /decide shortcodes — short handles that map back to a signed capability link.
// These carry NO extra authority: the stored sig is re-verified downstream, so
// a shortcode grants exactly what the long inline link would have.
// ---------------------------------------------------------------------------

/**
 * Persist a shortcode → signed-decide mapping. Throws ShortcodeCollisionError
 * on a primary-key conflict (duplicate code) so the caller can retry with a new
 * code; any other DB error is rethrown as a generic Error.
 */
export async function createDecideShortcode(input: {
  code: string
  owner_id: string
  channel: string
  sender: string
  label?: string | null
  exp: number
  sig: string
}): Promise<void> {
  const supabase = getSupabase()
  const { error } = await supabase.from('sna_decide_shortcodes').insert({
    code: input.code,
    owner_id: input.owner_id,
    channel: input.channel,
    sender: input.sender,
    label: input.label ?? null,
    exp: input.exp,
    sig: input.sig,
  })
  if (error) {
    // Postgres unique_violation → a code collision; signal it distinctly so the
    // caller retries rather than 500ing on a benign, rare event.
    if ((error as { code?: string }).code === '23505') {
      throw new ShortcodeCollisionError(error.message)
    }
    throw new Error(error.message)
  }
}

/**
 * Resolve a shortcode back to its signed-decide fields, or null if it does not
 * exist or has expired. Expiry is enforced here (in addition to the downstream
 * signature/exp re-check) so an expired code never even renders the form.
 */
export async function resolveDecideShortcode(code: string): Promise<{
  owner_id: string
  channel: string
  sender: string
  label: string | null
  exp: number
  sig: string
} | null> {
  if (!code) return null
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_decide_shortcodes')
    .select('owner_id,channel,sender,label,exp,sig')
    .eq('code', code)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  // Expired shortcodes resolve to null (link is dead just like the long form).
  if ((data as { exp: number }).exp <= Date.now()) return null
  return data as {
    owner_id: string
    channel: string
    sender: string
    label: string | null
    exp: number
    sig: string
  }
}

// ---------------------------------------------------------------------------
// Generalized capability ACTIONS (sna_actions).
//
// This is the sender approve/deny model extended to arbitrary actions (e.g. a
// Schwab trade). Every function here is owner-scoped just like the sender data
// access above — an action can only ever be read/mutated by the account that
// minted it (writes additionally re-verify the row's HMAC signature upstream).
// Reuses ShortcodeCollisionError for the unique `shortcode` retry loop.
// ---------------------------------------------------------------------------

/**
 * Persist a new pending action + its signed shortcode. Throws
 * ShortcodeCollisionError on a unique-`shortcode` conflict so the caller can
 * retry with a freshly generated code; any other DB error is rethrown.
 */
export async function createAction(input: {
  owner_id: string
  type: string
  payload: Record<string, unknown>
  description: string
  shortcode: string
  sig: string
  exp: number
}): Promise<Action> {
  assertOwner(input.owner_id)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_actions')
    .insert({
      owner_id: input.owner_id,
      type: input.type,
      payload: input.payload,
      description: input.description,
      status: 'pending',
      shortcode: input.shortcode,
      sig: input.sig,
      exp: new Date(input.exp).toISOString(),
    })
    .select('*')
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ShortcodeCollisionError(error.message)
    }
    throw new Error(error.message)
  }
  const row = data as Action
  assertRowOwned(row, input.owner_id)
  return row
}

/**
 * Resolve a shortcode back to its full action row, or null if the code does not
 * exist. Expiry is NOT filtered here (unlike decide shortcodes) so the /decide
 * page can render an accurate "expired"/"already decided" dead-end; callers
 * enforce status + expiry themselves.
 */
export async function getActionByShortcode(code: string): Promise<Action | null> {
  if (!code) return null
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_actions')
    .select('*')
    .eq('shortcode', code)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return data as Action
}

/**
 * Transition an action's status (owner-scoped). Optionally records the
 * execution timestamp + result payload. Returns the updated row, or null if no
 * matching pending-or-later row exists for this owner.
 *
 * `expectStatus`, when provided, makes the update a compare-and-set: the row is
 * only advanced when it is currently in that status. This makes approval
 * idempotent and prevents a double-execute race (two taps of Approve).
 */
export async function updateActionStatus(
  ownerId: string,
  code: string,
  next: {
    status: ActionStatus
    executed_at?: string | null
    result?: Record<string, unknown> | null
  },
  expectStatus?: ActionStatus
): Promise<Action | null> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const patch: Record<string, unknown> = { status: next.status }
  if (next.executed_at !== undefined) patch.executed_at = next.executed_at
  if (next.result !== undefined) patch.result = next.result
  let query = supabase
    .from('sna_actions')
    .update(patch)
    .eq('owner_id', ownerId)
    .eq('shortcode', code)
  if (expectStatus) query = query.eq('status', expectStatus)
  const { data, error } = await query.select('*').maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as Action
  assertRowOwned(row, ownerId)
  return row
}
