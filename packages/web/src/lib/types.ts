// Shared types for the soup-nazi list-manager server.
// NOTE: there is NO message type here on purpose. This server never sees content.

export type SenderStatus = 'approved' | 'denied'

/** Result of a sender check. 'unknown' = not present in the list. */
export type CheckStatus = 'approved' | 'denied' | 'unknown'

/**
 * A global channel TYPE (shared reference data). Defines which local adapter +
 * transport a channel uses. Rows live in sna_channel_types.
 */
export interface ChannelType {
  id: string
  display_name: string
  description: string | null
  enabled: boolean
  created_at: string
}

/**
 * A per-user channel INSTANCE ("a channel", with a name). Rows live in
 * sna_channels and are scoped to an owner. `slug` is what sna_senders.channel_id
 * references and what the CLI passes as `--channel`. Many instances may share a
 * `type` (e.g. a "Personal" and a "Work" gmail).
 *
 * NOTE: there are deliberately NO credentials here. OAuth tokens / app
 * passwords live ONLY on the CLI machine, never on the server.
 */
export interface Channel {
  id: string
  owner_id: string
  type: string
  name: string
  slug: string
  created_at: string
}

export interface Sender {
  id: string
  owner_id: string
  channel_id: string
  sender_address: string
  label: string | null
  status: SenderStatus
  decided_at: string
  decided_by: string | null
}

/** Lifecycle status of a generalized capability action (sna_actions). */
export type ActionStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'executed'

/**
 * A generalized capability ACTION awaiting (or past) the owner's one-tap
 * approval. This is the sender approve/deny model extended to arbitrary actions
 * (e.g. a Schwab trade). Rows live in sna_actions, are owner-scoped, and carry
 * an HMAC-signed shortcode identical in spirit to sna_decide_shortcodes.
 *
 * `payload` is opaque machine detail (what to execute); `description` is the
 * human-readable summary shown on the /decide page.
 */
export interface Action {
  id: string
  owner_id: string
  type: string
  payload: Record<string, unknown>
  description: string
  status: ActionStatus
  shortcode: string | null
  sig: string
  exp: string
  executed_at: string | null
  result: Record<string, unknown> | null
  created_at: string
}

/**
 * A service account. NOTE: password_hash is deliberately NOT part of this type
 * — it must never leave the server or be selected into UI-facing code paths.
 */
export interface User {
  id: string
  email: string
  read_token: string
  auto_approve_on_send: boolean
  created_at: string
}
