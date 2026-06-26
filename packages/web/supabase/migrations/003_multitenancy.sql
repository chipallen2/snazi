-- 003_multitenancy.sql
--
-- Turns the single-tenant list manager into a multi-tenant service: every
-- account owns its own approve/deny list. Tenant isolation is enforced in the
-- application layer (every query is scoped by owner_id via lib/data.ts) while
-- the service_role key continues to be the only credential that touches the DB.
-- RLS stays enabled with no policies, so nothing is reachable without that key.
--
-- IMPORTANT: This product still stores NO messages and NO message content.
-- sna_users holds only an email, a password hash, and a per-user READ token
-- (used by the Mac CLI). It never holds message data.
--
-- This migration WIPES any existing sender rows because it introduces a
-- NOT NULL owner_id. There is no production data to preserve.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts. One row per user of the service.
--   read_token: the CLI/agent credential (replaces the old global API key).
--               It is READ-scoped: it can check/list/label, never approve.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sna_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,        -- stored lowercased by the app
  password_hash TEXT NOT NULL,               -- scrypt: scrypt$<salt>$<dk>
  read_token    TEXT NOT NULL UNIQUE,        -- per-user CLI read token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sna_users ENABLE ROW LEVEL SECURITY;  -- no policies: service_role only

-- ---------------------------------------------------------------------------
-- Scope the sender list to an owner.
-- Wipe first: a NOT NULL owner_id cannot be backfilled for orphan rows.
-- ---------------------------------------------------------------------------
TRUNCATE TABLE sna_senders;

ALTER TABLE sna_senders
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES sna_users(id) ON DELETE CASCADE;

ALTER TABLE sna_senders ALTER COLUMN owner_id SET NOT NULL;

-- Old uniqueness was global (channel_id, sender_address). Now it is per-owner:
-- two different users may each have the same sender on their own lists.
ALTER TABLE sna_senders
  DROP CONSTRAINT IF EXISTS sna_senders_channel_id_sender_address_key;

CREATE UNIQUE INDEX IF NOT EXISTS sna_senders_owner_channel_addr_key
  ON sna_senders (owner_id, channel_id, sender_address);

CREATE INDEX IF NOT EXISTS sna_senders_owner_idx
  ON sna_senders (owner_id);

-- sna_channels remains a GLOBAL registry of channel TYPES (imessage, gmail…).
-- It is shared reference data, not per-user, so it is intentionally NOT scoped.
