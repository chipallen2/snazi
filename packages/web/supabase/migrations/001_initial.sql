-- soup-nazi-agent schema (already applied to Supabase project cmohqhotfywhmgikeatc)
--
-- IMPORTANT: This product stores NO messages and NO message content. Ever.
-- The server is strictly an approve/deny LIST manager. Message reading happens
-- locally on Chip's Mac via the wrapper CLI and never touches this database.
--
-- All tables prefixed `sna_` to avoid collisions in the shared Projectinator
-- Supabase project. RLS is enabled with NO policies, so only the service_role
-- key (used server-side by the Next.js API) can read/write.

-- ---------------------------------------------------------------------------
-- Channels registry (extensible: imessage now, gmail/etc later)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sna_channels (
  id           TEXT PRIMARY KEY,          -- e.g. 'imessage', 'gmail'
  display_name TEXT NOT NULL,
  description  TEXT,
  enabled      BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Sender approve/deny list (the ONLY source of truth for this product)
-- status: 'approved' or 'denied'. Absent from table = 'unknown'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sna_senders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     TEXT REFERENCES sna_channels(id) ON DELETE CASCADE,
  sender_address TEXT NOT NULL,           -- phone number or email
  label          TEXT,                    -- human-readable name
  status         TEXT NOT NULL DEFAULT 'approved',  -- 'approved' | 'denied'
  decided_at     TIMESTAMPTZ DEFAULT NOW(),
  decided_by     TEXT,
  UNIQUE (channel_id, sender_address)
);

CREATE INDEX IF NOT EXISTS sna_senders_channel_idx
  ON sna_senders (channel_id);

-- ---------------------------------------------------------------------------
-- Lock everything down: enable RLS, add no policies (service_role bypasses RLS)
-- ---------------------------------------------------------------------------
ALTER TABLE sna_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE sna_senders  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Seed the iMessage channel
-- ---------------------------------------------------------------------------
INSERT INTO sna_channels (id, display_name, description)
VALUES ('imessage', 'iMessage', 'Apple iMessage on Chip''s Mac')
ON CONFLICT (id) DO NOTHING;
