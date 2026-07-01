-- 006_decide_shortcodes.sql
-- Short handles for /decide capability links.
--
-- A row maps an opaque 8-char code back to the SAME signed fields a long
-- /decide?owner=...&sig=... URL would have carried. The stored sig is
-- re-verified by the /decide page + server actions, so a shortcode grants no
-- extra authority — it just keeps the SMS/chat link short. Rows are immutable
-- once written; expiry is enforced at read time (exp <= now) and old rows can
-- be pruned by the exp index.

create table if not exists sna_decide_shortcodes (
  code        text primary key,        -- 8 random [a-z0-9] chars
  owner_id    text not null,
  channel     text not null,
  sender      text not null,
  label       text,
  exp         bigint not null,         -- unix ms, mirrors the signed link's exp
  sig         text not null,
  created_at  timestamptz not null default now()
);

create index if not exists sna_decide_shortcodes_owner_idx
  on sna_decide_shortcodes (owner_id);
create index if not exists sna_decide_shortcodes_exp_idx
  on sna_decide_shortcodes (exp);
