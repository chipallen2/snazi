/**
 * Owner-scoped data access for the approve/deny list.
 *
 * THIS IS THE TENANT-ISOLATION CHOKE POINT. Every function REQUIRES an
 * ownerId and applies `.eq('owner_id', ownerId)` to every query. No other
 * module should query sna_senders directly — route everything through here so
 * a forgotten owner filter can never leak one tenant's list to another.
 */
import { getSupabase } from './supabase'
import type { CheckStatus, Sender, SenderStatus } from './types'

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

/** A single sender's approval status for one owner. */
export async function checkSender(
  ownerId: string,
  channel: string,
  address: string
): Promise<CheckStatus> {
  assertOwner(ownerId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('sna_senders')
    .select('status,owner_id')
    .eq('owner_id', ownerId)
    .eq('channel_id', channel)
    .eq('sender_address', address)
    .maybeSingle()
  if (error) throw new Error(error.message)
  assertRowOwned(data as { owner_id?: string } | null, ownerId)
  return (data?.status as CheckStatus) ?? 'unknown'
}

/** Fetch one full sender row for one owner (or null). */
export async function getSender(
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
