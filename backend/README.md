# MoneyCircle Backend (Supabase) — v1.2.1

Source of truth:
- Execution plan: `MASTER_PLAN.md` (M2 — Backend)
- Spec/guide: `docs/BUILD_GUIDE.md` (Part 2 — Backend)

## What’s in this folder (current)
- `backend/migrations/001_init.sql`: Postgres schema (mirror DB; on-chain is truth)
- `backend/migrations/002_wallet_bind_challenges.sql`: Wallet bind challenges (TonConnect `signData`)
- `backend/migrations/003_circles_name.sql`: Optional `circles.name` for UI
- `backend/migrations/004_onchain_mirror_fields.sql`: Extra mirror fields for UI (phase, funded_count, jetton_wallet, due_remaining)
- `backend/migrations/005_rate_limits.sql`: Fixed-window rate limiting primitive + RPC (`check_rate_limit`)
- `backend/migrations/006_ops_monitoring.sql`: Ops fields + notifications kind extension (`ops_alert`)
- Edge Functions (Supabase / Deno):
  - `backend/functions/auth-telegram`: `POST /auth/telegram`
  - `backend/functions/group-verify`: `GET /group/verify?circle_id=...`
  - `backend/functions/circles-create`: `POST /circles`
  - `backend/functions/circles-list`: `GET /circles` (list circles for current group)
  - `backend/functions/circles-join`: `POST /circles/:id/join` (MVP: pass `circle_id` in body)
  - `backend/functions/circles-accept-rules`: `POST /circles/:id/accept_rules` (MVP: pass `circle_id` in body)
  - `backend/functions/circles-attach-contract`: `POST /circles/:id/attach_contract` (MVP: pass `circle_id` in body)
  - `backend/functions/wallet-bind-challenge`: `POST /wallet/bind_challenge`
  - `backend/functions/wallet-bind-confirm`: `POST /wallet/bind_confirm`
  - `backend/functions/circles-join-ticket`: `POST /circles/:id/join_ticket` (MVP: pass `circle_id` in body)
  - `backend/functions/circles-deposit-intent`: `POST /circles/:id/deposit_intent` (optional UX helper)
  - `backend/functions/jetton-wallet-address`: `POST /jetton-wallet-address` (helper: resolve user’s USDT Jetton wallet)
  - `backend/functions/circles-status`: `GET /circles/:id/status?circle_id=...`
  - `backend/functions/tx-notify`: `POST /tx/notify` (optional UX helper; indexer still required)
  - `backend/functions/indexer-sync`: `POST /indexer/sync` (scheduled; mirrors on-chain state via get methods)
  - `backend/functions/notify-scheduler`: `POST /notify/scheduler` (scheduled; enqueues reminders)
  - `backend/functions/bot-sender`: `POST /bot/sender` (scheduled; sends queued reminders)
  - `backend/functions/ops-health-check`: `POST /ops/health-check` (scheduled; optional founder alerts)

## Environment variables (server-only)
Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` (Telegram Bot API)
- `TELEGRAM_WEBAPP_SECRET` (preferred) or `TELEGRAM_BOT_TOKEN` (used for initData verification)
- `GUARDIAN_PRIVATE_KEY` (32-byte hex seed; used to derive ed25519 keypair for ticket signing)
- `MAX_POT_CAP_UNITS` (e.g. `500000000` for 500 USDT with 6 decimals)
- `MIN_DEPOSIT_UNITS` (anti-spam minimum deposit units; e.g. `100000` for 0.1 USDT)
- `TONCONNECT_ALLOWED_DOMAINS` (comma-separated allowlist; required for wallet bind)

Optional:
- `COLLATERAL_RATE_BPS` (default `1000` = 10%)
- `USDT_JETTON_MASTER` (string; stored on circle records)
- `TONAPI_BASE_URL` (default `https://tonapi.io`)
- `TONAPI_KEY` (optional; used to fetch wallet public key)
- `TONCENTER_ENDPOINT`, `TONCENTER_KEY` (optional; alternative way to fetch wallet public key)
- `TONCONNECT_MAX_AGE_SECONDS` (default `900`)
- `INDEXER_CRON_SECRET` (optional; if set, cron calls must include `x-cron-secret: ...`)
- `OPS_ADMIN_TELEGRAM_USER_ID` (optional; if set, `ops-health-check` sends DM alerts to this user id)
- `INDEXER_LAG_THRESHOLD_SECONDS` (optional; default `300`)
- `MINIAPP_PUBLIC_URL` (optional but recommended; used for join/withdraw links in bot messages, e.g. `https://your.domain/miniapp`)

## Apply schema
Run:
- `backend/migrations/001_init.sql`
- `backend/migrations/002_wallet_bind_challenges.sql`
- `backend/migrations/003_circles_name.sql`
- `backend/migrations/004_onchain_mirror_fields.sql`
- `backend/migrations/005_rate_limits.sql`
- `backend/migrations/006_ops_monitoring.sql`

…in Supabase SQL editor (or your migration pipeline).

RLS is enabled for all tables in the migration. Access should be via service role from Edge Functions.

## Edge Functions (notes)
These are written for Supabase Edge Functions (Deno).

### `auth-telegram`
Input: `{ "initData": "<Telegram WebApp initData string>" }`
Output: `{ session_token, user, group }`

### `wallet-bind-challenge`
Auth: `Authorization: Bearer <session_token>`
Input: `{ "circle_id": "<uuid>" }`
Output: `{ nonce, exp, message_to_sign }` where `message_to_sign = "MC_BIND|tg_uid|circle_id|nonce|exp"`

### `wallet-bind-confirm`
Auth: `Authorization: Bearer <session_token>`
Input: `{ "circle_id": "<uuid>", "sign_data": <TonConnect signData result> }`
Output: `{ ok, wallet_address, member }`

Wallet verification uses TonConnect `signData` (type=`text`) signature verification (domain allowlisted + timestamp freshness), and fetches the wallet public key via TonAPI.

### `circles-join-ticket`
Auth: `Authorization: Bearer <session_token>`
Input: `{ "circle_id": "<uuid>", "wallet_address": "<optional>" }` (MVP: pass `circle_id` in body)
Output: `{ wallet, exp, nonce, sig, contract_address }`

Ticket signing matches the on-chain hash format in `contracts/CircleContract.tact` (`MC_JOIN|contract|wallet|exp|nonce`).

### `circles-deposit-intent` (USDT Jetton transfer helper)
Auth: `Authorization: Bearer <session_token>`
Input: `{ "circle_id": "<uuid>", "purpose": "collateral"|"prefund", "amount_usdt": "10" }`
Output: `{ jetton_wallet, tx_value_nano, payload_base64, ... }`

Safety checks:
- Requires `circle.onchain_jetton_wallet` is set (user must run contract `INIT` first) to avoid silent deposit loss.
- Requires member `join_status == onchain_joined` (non-members are ignored by contract with no refund).
- Requires `amount_usdt >= min_deposit_units` (contract ignores smaller deposits).

## Next work (per MASTER_PLAN.md)
- Add richer bot messaging (join post + progress edit + settlement/default).
- Add provider lag dashboards / alerts.
