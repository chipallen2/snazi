-- 007_actions.sql
-- Generalized capability ACTIONS (the approve/deny model extended beyond senders).
--
-- snazi began as a MESSAGING gate: /decide links approve/deny a SENDER. This
-- migration generalizes that same one-tap, HMAC-signed approval flow to an
-- arbitrary ACTION (e.g. a Schwab trade). An action carries a machine payload
-- (what to do), a human description (what the owner sees), a status lifecycle,
-- and the SAME signed-shortcode pattern as sna_decide_shortcodes so the link
-- can be sent over SMS/Telegram and re-verified downstream.
--
-- SECURITY / SAFETY:
--   * ADD-ONLY. This migration creates ONE new table and its indexes. It does
--     NOT touch, alter, drop, or truncate any existing table or row. The live
--     senders/channels/users/shortcodes data is untouched.
--   * Like every other snazi table, RLS is enabled with NO policies: nothing is
--     reachable except through the service_role key, and the application layer
--     (lib/data.ts) scopes every query by owner_id.
--   * The stored `sig` is an HMAC over owner+shortcode+exp (mirrors the decide
--     link). It is re-verified on the /decide page and in the decide action, so
--     a shortcode grants no authority beyond what its owner minted.
--
-- STATUS lifecycle: pending -> approved -> executed (success)  |  denied  |  expired
--   pending  : minted, awaiting the owner's tap
--   approved : owner tapped Approve (transient; execution follows immediately)
--   executed : the action ran (result/error captured in `result`)
--   denied   : owner tapped Deny
--   expired  : never decided before `exp`

create table if not exists sna_actions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references sna_users(id) on delete cascade,
  type        text not null,                          -- e.g. 'schwab_trade'
  payload     jsonb not null,                         -- full machine action details
  description text not null,                          -- human-readable for the UI
  status      text not null default 'pending',        -- pending/approved/denied/expired/executed
  shortcode   text unique,                            -- 8-char code for /decide?a=<code>
  sig         text not null,                          -- HMAC over owner+shortcode+exp
  exp         timestamptz not null,                   -- link/action expiry
  executed_at timestamptz,
  result      jsonb,                                  -- execution result or error
  created_at  timestamptz not null default now()
);

create index if not exists sna_actions_owner_idx on sna_actions (owner_id);
create index if not exists sna_actions_shortcode_idx on sna_actions (shortcode);

-- Match the rest of the schema: RLS on, no policies -> service_role-only.
alter table sna_actions enable row level security;
