/**
 * Owner-scoped data access for the approve/deny list.
 *
 * THIS IS THE TENANT-ISOLATION CHOKE POINT. Every function REQUIRES an
 * ownerId and applies `.eq('owner_id', ownerId)` to every query. No other
 * module should query sna_senders directly — route everything through here so
 * a forgotten owner filter can never leak one tenant's list to another.
 */
import { getSupabase } from './supabase'
import { extractEmailDomain, domainWildcard } from './address'
import type { Channel, ChannelType, CheckStatus, Sender, SenderStatus } from './types'

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

  // Candidate addresses: the exact sender + (for emails) its domain wildcard.
  const candidates: string[] = [address]
  const domain = extractEmailDomain(address)
  // Guard: a wildcard's own domain wildcard would be itself; don't duplicate.
  if (domain && domainWildcard(domain) !== address) {
    candidates.push(domainWildcard(domain))
  }

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

  // Exact match wins over the domain wildcard.
  const exact = rows.find((r) => r.sender_address === address)
  if (exact) return exact.status as CheckStatus
  const wildcard = rows.find((r) => r.sender_address !== address)
  if (wildcard) return wildcard.status as CheckStatus
  return 'unknown'
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

  const candidates: string[] = [address]
  const domain = extractEmailDomain(address)
  if (domain && domainWildcard(domain) !== address) {
    candidates.push(domainWildcard(domain))
  }

  const { data, error } = await supabase
    .from('sna_senders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .in('sender_address', candidates)
  if (error) throw new Error(error.message)

  const rows = (data as Sender[]) ?? []
  for (const row of rows) assertRowOwned(row, ownerId)

  const exact = rows.find((r) => r.sender_address === address)
  if (exact) return exact
  const wildcard = rows.find((r) => r.sender_address !== address)
  return wildcard ?? null
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
