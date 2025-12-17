-- Round (v1.2.1) — rate limiting primitives (MVP)
-- Goal: protect critical endpoints from abuse without inventing product behavior.
-- Implementation: fixed-window counters keyed by (key, action, window_start).

create table if not exists public.rate_limits (
  rl_key text not null,
  action text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (rl_key, action, window_start)
);

create index if not exists rate_limits_action_window_idx on public.rate_limits (action, window_start);

-- Atomic fixed-window rate limiter.
-- Returns a single row with {allowed,count,limit,reset_at}.
create or replace function public.check_rate_limit(
  p_action text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  count integer,
  limit integer,
  reset_at timestamptz
)
language plpgsql
as $$
declare
  wstart timestamptz;
  newcount integer;
begin
  if p_window_seconds <= 0 then
    raise exception 'window_seconds must be positive';
  end if;
  if p_limit <= 0 then
    raise exception 'limit must be positive';
  end if;

  wstart := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits (rl_key, action, window_start, count)
    values (p_key, p_action, wstart, 1)
  on conflict (rl_key, action, window_start)
    do update set count = public.rate_limits.count + 1
  returning public.rate_limits.count into newcount;

  allowed := newcount <= p_limit;
  count := newcount;
  limit := p_limit;
  reset_at := wstart + make_interval(secs => p_window_seconds);
  return next;
end;
$$;

alter table public.rate_limits enable row level security;

