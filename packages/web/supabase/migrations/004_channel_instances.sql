-- 004_channel_instances.sql
--
-- Named, per-user channel INSTANCES (multiple per type).
--
-- Before this migration a "channel" was a single GLOBAL type (`imessage`), so a
-- user could not have, say, a "Personal" Gmail and a "Work" Gmail at the same
-- time. This migration splits the concept in two:
--
--   * sna_channel_types — the GLOBAL registry of channel TYPES (imessage,
--     gmail, outlook). Shared reference data; defines which local adapter +
--     transport a channel uses. Not per-user.
--
--   * sna_channels — PER-USER channel INSTANCES. Each row is one named
--     connection of a given type (e.g. name "Work", type "gmail", slug
--     "gmail-work"). A user may have many instances of the same type.
--
-- sna_senders.channel_id now stores the per-user instance SLUG (it was the
-- global type id). Because senders are already owner-scoped, the slug only has
-- to be unique per owner.
--
-- IMPORTANT: This product still stores NO messages and NO message content, and
-- NO channel credentials. OAuth tokens / app passwords live ONLY on the CLI
-- machine (~/.snazi/config.json). The server keeps just the instance's name +
-- type so the dashboard can show one approve/deny list per channel.
--
-- PRESERVES existing data. This migration is NON-DESTRUCTIVE:
--   * sna_senders rows are kept (every existing sender already has
--     channel_id = 'imessage'; section 4 seeds a per-user 'imessage' instance
--     whose slug is ALSO 'imessage', so the rows re-point transparently — no
--     approve/deny decisions are lost).
--   * The old global sna_channels table is UPGRADED IN PLACE, not dropped: it
--     already WAS the channel-type registry, so it is renamed to
--     sna_channel_types, keeping every type row and its `enabled` flag.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Detach senders from the old global channel registry, but KEEP the rows.
--    The old FK pointed channel_id at the global sna_channels(id); that table is
--    becoming the per-user instances table, so the constraint has to go. The
--    channel_id VALUES ('imessage') stay and become instance slugs in step 4.
-- ---------------------------------------------------------------------------
ALTER TABLE sna_senders DROP CONSTRAINT IF EXISTS sna_senders_channel_id_fkey;

-- Defensive: a legacy NULL channel_id (channel_id was nullable in 001) becomes
-- the default 'imessage' slug so every preserved approval maps to the seeded
-- instance below.
UPDATE sna_senders SET channel_id = 'imessage' WHERE channel_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2) UPGRADE the old registry in place → global channel TYPES registry.
--    The pre-004 `sna_channels` table WAS the type registry
--    (id/display_name/description/enabled), and its columns match
--    sna_channel_types exactly — so RENAME it rather than dropping it. This
--    preserves every existing type row (including any custom types and their
--    enabled flags). The PK index is renamed too so the new per-user
--    sna_channels table (step 3) can reuse the freed-up sna_channels_pkey name.
--    (CREATE IF NOT EXISTS is a fallback for a from-scratch DB with no 001.)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS sna_channels   RENAME TO sna_channel_types;
ALTER INDEX IF EXISTS sna_channels_pkey RENAME TO sna_channel_types_pkey;

CREATE TABLE IF NOT EXISTS sna_channel_types (
  id           TEXT PRIMARY KEY,          -- 'imessage', 'gmail', 'outlook'
  display_name TEXT NOT NULL,
  description  TEXT,
  enabled      BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE sna_channel_types ENABLE ROW LEVEL SECURITY;  -- (idempotent) service_role only

-- Ensure the built-in types exist. 'imessage' carried over from the rename;
-- gmail/outlook are added here. ON CONFLICT keeps any pre-existing rows intact.
INSERT INTO sna_channel_types (id, display_name, description) VALUES
  ('imessage', 'iMessage', 'Apple iMessage on the user''s Mac (macOS only).'),
  ('gmail',    'Gmail',    'Google Gmail via the Gmail API (OAuth2). Read + send.'),
  ('outlook',  'Outlook',  'Microsoft Outlook / 365 via Microsoft Graph (OAuth2). Read + send.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) Per-user channel INSTANCES ("channels", each with a name).
--    slug is what sna_senders.channel_id references and what the CLI passes as
--    --channel. Unique per owner (senders are already owner-scoped).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sna_channels (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES sna_users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL REFERENCES sna_channel_types(id),
  name       TEXT NOT NULL,                       -- e.g. 'Personal', 'Work'
  slug       TEXT NOT NULL,                       -- e.g. 'gmail-work' (= channel_id)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS sna_channels_owner_idx ON sna_channels (owner_id);

ALTER TABLE sna_channels ENABLE ROW LEVEL SECURITY;  -- service_role only

-- ---------------------------------------------------------------------------
-- 4) Give every existing account a default 'imessage' instance. The slug
--    'imessage' matches the old channel_id, so the preserved senders above —
--    plus existing CLI configs and /decide links — keep working unchanged.
--    Every sender's owner is a row in sna_users, so this guarantees no
--    preserved approval is left pointing at a missing instance.
-- ---------------------------------------------------------------------------
INSERT INTO sna_channels (owner_id, type, name, slug)
SELECT id, 'imessage', 'iMessage', 'imessage' FROM sna_users
ON CONFLICT (owner_id, slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5) Sanity check (raises if any approval would be orphaned by the re-point).
--    Pure guard: with the seed above this should always find zero rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphans
  FROM sna_senders s
  LEFT JOIN sna_channels c
    ON c.owner_id = s.owner_id AND c.slug = s.channel_id
  WHERE c.id IS NULL;

  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Aborting: % sender(s) reference a channel slug with no matching instance', orphans;
  END IF;
END $$;
