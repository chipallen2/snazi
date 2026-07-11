-- 008_auto_approve_on_send.sql
--
-- Adds a per-account boolean setting `auto_approve_on_send` (default TRUE).
-- When enabled, any recipient the agent sends a message TO is automatically
-- upserted to 'approved' on that channel's sender list, so when that person
-- replies the agent can read the reply without a manual approve step.
--
-- The setting is checked server-side in the auto-approve API endpoint. If the
-- owner turns it off (via the Account page toggle), the endpoint becomes a
-- no-op. This does NOT bypass the gate for any other path - only outbound
-- send recipients are auto-approved, and only when the flag is on.

ALTER TABLE sna_users
  ADD COLUMN IF NOT EXISTS auto_approve_on_send BOOLEAN NOT NULL DEFAULT TRUE;
