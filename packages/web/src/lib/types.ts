// Shared types for the soup-nazi list-manager server.
// NOTE: there is NO message type here on purpose. This server never sees content.

export type SenderStatus = 'approved' | 'denied'

/** Result of a sender check. 'unknown' = not present in the list. */
export type CheckStatus = 'approved' | 'denied' | 'unknown'

export interface Channel {
  id: string
  display_name: string
  description: string | null
  enabled: boolean
  created_at: string
}

export interface Sender {
  id: string
  channel_id: string
  sender_address: string
  label: string | null
  status: SenderStatus
  decided_at: string
  decided_by: string | null
}
