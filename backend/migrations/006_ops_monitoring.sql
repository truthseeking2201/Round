-- Round (v1.2.1) — ops monitoring + notifications extensions (MVP)
-- Adds:
-- - circles: last indexer attempt/success/error fields
-- - notifications_queue.kind: add 'ops_alert' for founder DM alerts (optional)

alter table public.circles
  add column if not exists last_indexer_attempt_at timestamptz,
  add column if not exists last_indexed_at timestamptz,
  add column if not exists last_indexer_error text;

-- Extend notification kinds (used by bot_sender).
-- Note: 001_init.sql created an unnamed CHECK constraint; in Postgres it defaults to <table>_<column>_check.
alter table public.notifications_queue
  drop constraint if exists notifications_queue_kind_check;

alter table public.notifications_queue
  add constraint notifications_queue_kind_check
  check (kind in ('due_reminder','auction_open','reveal_reminder','settlement','default','emergency','ops_alert'));

