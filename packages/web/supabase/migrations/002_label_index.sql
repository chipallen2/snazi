-- 002_label_index.sql  (OPTIONAL / non-blocking)
--
-- Adds an index on sna_senders.label to speed up name->address resolution
-- (the /resolve endpoint / `remote-resolve`). This is a pure performance
-- optimization: the feature works correctly WITHOUT it. The sender list is
-- small (a personal allow/deny list), so this is low priority and may need to
-- be applied manually against the Supabase project — it is NOT auto-applied by
-- the deploy pipeline.
--
-- Note: substring (ILIKE/includes) matching is done in application code, so a
-- plain btree index mainly helps exact-prefix/ordering scans and keeps the
-- column ready for future server-side filtering.

CREATE INDEX IF NOT EXISTS sna_senders_label_idx
  ON sna_senders (label);
