-- Round (v1.2.1) — wallet bind challenges (TonConnect signData)
-- Source of truth: docs/BUILD_GUIDE.md (POST /wallet/bind_challenge, /wallet/bind_confirm)

create table if not exists public.wallet_bind_challenges (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(circle_id) on delete cascade,
  telegram_user_id bigint not null references public.tg_users(telegram_user_id) on delete cascade,
  nonce text not null,
  exp timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  unique (circle_id, telegram_user_id, nonce)
);

create index if not exists wallet_bind_challenges_lookup_idx
  on public.wallet_bind_challenges (circle_id, telegram_user_id, nonce);

create index if not exists wallet_bind_challenges_active_idx
  on public.wallet_bind_challenges (circle_id, telegram_user_id, used, exp);

alter table public.wallet_bind_challenges enable row level security;

