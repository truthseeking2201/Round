-- Round (v1.2.1) — Supabase/Postgres schema (MVP)
-- Source of truth: docs/BUILD_GUIDE.md (Part 2 — Backend)
-- Notes:
-- - DB is a mirror for UX; on-chain is truth.
-- - Recommended: enable RLS and only access via Edge Functions (service role).

create extension if not exists pgcrypto;

-- -----------------------------
-- Helpers
-- -----------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------
-- Core tables
-- -----------------------------

create table if not exists public.tg_users (
  telegram_user_id bigint primary key,
  username text,
  first_name text,
  last_name text,
  photo_url text,
  language_code text,
  risk_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tg_users_set_updated_at
before update on public.tg_users
for each row execute function public.set_updated_at();

create table if not exists public.tg_groups (
  group_chat_id bigint primary key,
  title text,
  type text,
  bot_present boolean not null default false,
  bot_admin boolean not null default false,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tg_groups_set_updated_at
before update on public.tg_groups
for each row execute function public.set_updated_at();

create table if not exists public.sessions (
  session_token text primary key,
  telegram_user_id bigint not null references public.tg_users(telegram_user_id) on delete cascade,
  group_chat_id bigint references public.tg_groups(group_chat_id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_expires_at_idx on public.sessions (expires_at);
create index if not exists sessions_user_idx on public.sessions (telegram_user_id);

create table if not exists public.circles (
  circle_id uuid primary key default gen_random_uuid(),
  group_chat_id bigint not null references public.tg_groups(group_chat_id) on delete restrict,
  leader_user_id bigint not null references public.tg_users(telegram_user_id) on delete restrict,

  status text not null check (status in ('Recruiting','Locked','Active','Completed','Terminated','EmergencyStop')),

  contract_address text,
  jetton_master text,

  -- Config snapshot (v1.2.1)
  n_members integer not null,
  contribution_units bigint not null,
  total_cycles integer not null,
  interval_sec integer not null,
  grace_sec integer not null,
  take_rate_bps integer not null,
  collateral_rate_bps integer not null,
  max_discount_bps integer not null,
  vesting_bps_cycle1 integer not null,
  early_lock_rate_bps_cycle1 integer not null,
  commit_duration_sec integer not null,
  reveal_duration_sec integer not null,
  max_pot_cap_units bigint not null,
  min_deposit_units bigint not null,

  current_cycle_index integer not null default 0,
  onchain_due_at timestamptz,
  onchain_grace_end_at timestamptz,
  onchain_commit_end_at timestamptz,
  onchain_reveal_end_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists circles_group_idx on public.circles (group_chat_id);
create index if not exists circles_status_idx on public.circles (status);

create trigger circles_set_updated_at
before update on public.circles
for each row execute function public.set_updated_at();

create table if not exists public.circle_members (
  circle_id uuid not null references public.circles(circle_id) on delete cascade,
  telegram_user_id bigint not null references public.tg_users(telegram_user_id) on delete cascade,
  wallet_address text,
  join_status text not null check (join_status in ('joined','accepted_rules','wallet_verified','ticket_issued','onchain_joined','exited')),
  rules_signature_hash text,
  has_won boolean not null default false,

  -- Mirror balances (units)
  collateral bigint not null default 0,
  prefund bigint not null default 0,
  credit bigint not null default 0,
  vesting_locked bigint not null default 0,
  vesting_released bigint not null default 0,
  future_locked bigint not null default 0,
  withdrawable bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (circle_id, telegram_user_id)
);

create index if not exists circle_members_wallet_idx on public.circle_members (circle_id, wallet_address);
create index if not exists circle_members_join_status_idx on public.circle_members (circle_id, join_status);

create trigger circle_members_set_updated_at
before update on public.circle_members
for each row execute function public.set_updated_at();

create table if not exists public.wallet_bindings (
  telegram_user_id bigint primary key references public.tg_users(telegram_user_id) on delete cascade,
  wallet_address text not null unique,
  verified_at timestamptz not null default now()
);

create table if not exists public.join_tickets (
  circle_id uuid not null references public.circles(circle_id) on delete cascade,
  telegram_user_id bigint not null references public.tg_users(telegram_user_id) on delete cascade,
  wallet_address text not null,
  exp timestamptz not null,
  nonce text not null,
  sig text not null,
  used boolean not null default false,
  issued_at timestamptz not null default now(),
  unique (circle_id, wallet_address, nonce)
);

create index if not exists join_tickets_user_idx on public.join_tickets (telegram_user_id);
create index if not exists join_tickets_circle_idx on public.join_tickets (circle_id);

create table if not exists public.chain_events (
  id uuid primary key default gen_random_uuid(),
  contract_address text not null,
  tx_hash text not null,
  lt bigint not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  processed boolean not null default false,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create index if not exists chain_events_processed_idx on public.chain_events (processed, created_at);
create index if not exists chain_events_contract_lt_idx on public.chain_events (contract_address, lt);

create table if not exists public.bot_messages (
  group_chat_id bigint not null references public.tg_groups(group_chat_id) on delete cascade,
  circle_id uuid not null references public.circles(circle_id) on delete cascade,
  message_type text not null check (message_type in ('JoinPost','Progress','Auction','Settlement','Default','Emergency')),
  message_id bigint not null,
  pinned boolean not null default false,
  last_edited_at timestamptz,
  primary key (group_chat_id, circle_id, message_type)
);

create table if not exists public.notifications_queue (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('group','dm')),
  group_chat_id bigint references public.tg_groups(group_chat_id) on delete cascade,
  telegram_user_id bigint references public.tg_users(telegram_user_id) on delete cascade,
  circle_id uuid not null references public.circles(circle_id) on delete cascade,
  cycle_index integer,
  kind text not null check (kind in ('due_reminder','auction_open','reveal_reminder','settlement','default','emergency')),
  payload jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null,
  status text not null check (status in ('pending','sent','failed')) default 'pending',
  fail_reason text,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists notifications_queue_status_sched_idx on public.notifications_queue (status, scheduled_at);

-- -----------------------------
-- RLS (recommended)
-- -----------------------------

alter table public.tg_users enable row level security;
alter table public.tg_groups enable row level security;
alter table public.sessions enable row level security;
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.wallet_bindings enable row level security;
alter table public.join_tickets enable row level security;
alter table public.chain_events enable row level security;
alter table public.bot_messages enable row level security;
alter table public.notifications_queue enable row level security;

