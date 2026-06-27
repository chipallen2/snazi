-- 005_sender_channel_fk_cleanup.sql
--
-- Repair: sna_senders.channel_id must hold a per-user channel INSTANCE slug
-- (e.g. 'gmail-gofer', 'outlook-work'), NOT a global channel TYPE id. Some
-- databases still carry a leftover FOREIGN KEY that constrains channel_id to a
-- channel-type id, so approving a sender on any non-default channel fails with:
--
--   insert or update on table "sna_senders" violates foreign key constraint
--   "..._channel_id_fkey" — Key (channel_id)=(gmail-gofer) is not present in
--   table "sna_channel_types".
--
-- Why 004 missed it: 004 dropped the constraint by its EXPECTED name
-- (sna_senders_channel_id_fkey). But a database whose senders table was first
-- created under an earlier name (e.g. "sna_approved_senders") kept the FK under
-- that legacy name (sna_approved_senders_channel_id_fkey), so the IF EXISTS drop
-- was a no-op. When 004 then renamed the old type table to sna_channel_types,
-- the stray FK simply re-pointed at it and kept enforcing TYPE ids.
--
-- The same legacy-name problem means 003's intended drop of the OLD global
-- UNIQUE (channel_id, sender_address) may also have been a no-op, leaving a
-- non-tenant-safe constraint that would reject two different owners approving
-- the same address on the same channel slug (e.g. both having 'imessage').
--
-- channel_id is intentionally NOT foreign-keyed and uniqueness is owner-scoped
-- (the unique INDEX sna_senders_owner_channel_addr_key from 003 stays). This
-- migration drops, by whatever name they carry:
--   1) ANY foreign key on sna_senders that involves channel_id, and
--   2) ANY UNIQUE *constraint* on exactly (channel_id, sender_address).
-- It is idempotent: a no-op on databases where 003/004 already removed them.

DO $$
DECLARE
  rec            record;
  chan_attnum    smallint;
  addr_attnum    smallint;
BEGIN
  SELECT attnum INTO chan_attnum
    FROM pg_attribute
   WHERE attrelid = 'sna_senders'::regclass AND attname = 'channel_id';
  SELECT attnum INTO addr_attnum
    FROM pg_attribute
   WHERE attrelid = 'sna_senders'::regclass AND attname = 'sender_address';

  FOR rec IN
    SELECT conname, contype, conkey
      FROM pg_constraint
     WHERE conrelid = 'sna_senders'::regclass
  LOOP
    -- 1) Any FK touching channel_id (it is a per-user slug, not a type id).
    IF rec.contype = 'f' AND chan_attnum = ANY (rec.conkey) THEN
      EXECUTE format('ALTER TABLE sna_senders DROP CONSTRAINT %I', rec.conname);
      RAISE NOTICE 'Dropped stray channel_id FK: %', rec.conname;

    -- 2) The OLD global UNIQUE (channel_id, sender_address). The owner-scoped
    --    uniqueness from 003 is a unique INDEX (not a constraint), so it is not
    --    matched here and is preserved.
    ELSIF rec.contype = 'u'
      AND array_length(rec.conkey, 1) = 2
      AND chan_attnum = ANY (rec.conkey)
      AND addr_attnum = ANY (rec.conkey) THEN
      EXECUTE format('ALTER TABLE sna_senders DROP CONSTRAINT %I', rec.conname);
      RAISE NOTICE 'Dropped stray global UNIQUE (channel_id, sender_address): %', rec.conname;
    END IF;
  END LOOP;
END $$;
