-- Round (v1.2.1) — add extra on-chain mirror fields required by the Mini App
-- Source of truth: docs/UI_SPEC.md + docs/BUILD_GUIDE.md (mirror fields are for UX only; chain remains truth)

alter table public.circles
  add column if not exists onchain_phase integer,
  add column if not exists onchain_funded_count integer,
  add column if not exists onchain_jetton_wallet text;

alter table public.circle_members
  add column if not exists due_remaining bigint not null default 0;

