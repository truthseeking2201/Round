-- Round (v1.2.1) — optional circle name for UI
-- Source of truth: docs/UI_SPEC.md (Create Circle)

alter table public.circles
  add column if not exists name text;

