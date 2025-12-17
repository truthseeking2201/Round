# MoneyCircle — Master Plan (MVP v1.2.1 Hardened)

**Primary Goal:** Zero incidents of money loss due to bugs or hacks (No-loss P0)  
**Platform:** Telegram Mini App + Telegram Bot + TON (USDT Jetton) Smart Contract + Supabase Backend  
**Owner:** Solo Founder (PM + Designer + Dev)  

> This file is the "execution roadmap" for **cross-referencing everything**: scope, build order, gate criteria (gates), checklists, and Definition of Done.  
> Rule: **do not invent behavior**. When there is a conflict, prioritize the "implementation spec" below.

## 0) Document hierarchy (priority order for cross-referencing)

1. **Contract behavior (normative):** `docs/CONTRACT_SPEC.md`
2. **Implementation guide (normative):** `docs/BUILD_GUIDE.md`
3. **Security/QA must-pass:** `docs/SECURITY_TESTS.md`
4. **This file (execution plan):** `MASTER_PLAN.md` (scope, WBS, gates, DoD)
5. **UI-only spec (non-normative):** `docs/UI_SPEC.md` (copy/screens; does not override contract rules)
6. **UI edge-case checklist:** `docs/UI_EDGE_CASES.md` (QA checklist; does not override contract rules)

## 1) Scope & Non-goals

### 1.1 MVP v1.2.1 "Hardened" — required features
- **1 Circle = 1 Contract**, escrow USDT Jetton, time gates on-chain.
- Join using **signed ticket** (domain-separated + nonce anti-replay).
- Deposit collateral/prefund via **Jetton transfer_notification** + **anti-spoof**.
- Funding engine: `due_at <= now < grace_end_at`, idempotent debit via `due_remaining`, auto-debit-on-deposit.
- Auction commit–reveal: windows on-chain, non-reveal does not break the round, deterministic tie-break.
- Settlement: fee, credit distribution, vesting + safety lock (cycle 1), deterministic dust policy (no orphan dust).
- Default terminate after grace: refund + seize + distribute, **pull withdrawals**.
- `WITHDRAW` mode-based (fixes liquidity trap + recruiting deadlock).
- EmergencyStop: freezes all ops except withdrawals.
- Backend non-custodial: Telegram auth, group verify, wallet proof, ticket signing, indexer + bot notify.

### 1.2 Non-goals (not in v1)
- Lending/loans outside the contribution round; yield/float using user funds.
- Fiat custody / direct on/off-ramp.
- Multi-token (USDC…), reputation scoring, referral/commission, collusion heuristics (P1).

## 2) Principles (to prevent "drift")

### 2.1 Safety-first invariants (must always hold)
- `pot = N*C` invariant after lock.
- `pot_pool <= pot` always true.
- `due_remaining[m] >= 0` always true.
- `funded_count <= N` always true.
- Settlement runs at most once per cycle (`settled` flag).
- Penalty applied at most once per flag (`late_penalty_applied`, `non_reveal_penalty_applied`).
- Guardian **cannot** withdraw user funds (only freeze + treasury withdraw per rules).

### 2.2 Time gates (strict boundaries)
- Debit: `due_at <= now < grace_end_at` (**exclusive grace end**).
- Terminate: `now >= grace_end_at`.
- Commit: `now < commit_end_at`.
- Reveal: `now < reveal_end_at`.
- Finalize: `now >= reveal_end_at`.

### 2.3 Idempotency everywhere
- On-chain: debit via `due_remaining`, settle via `settled` flag, nonce replay protection.
- Off-chain: all handlers "upsert from chain truth", no cumulative deltas unless with idempotency key.

## 3) Target repo structure (project destination)

> Repo already has scaffold for Tact + Vitest (`contracts/`, `tests/`, `tact.config.json`, `vitest.config.ts`).  
> When fully implemented, maintain the structure below for easy audit + CI.

- `contracts/`
  - `CircleContract.tact`
  - `README.md` (deploy/test/audit checklist)
- `tests/` (unit + adversarial; run with `vitest`)
- `scripts/` (deploy, init, verify)
- `backend/` (Supabase)
  - `migrations/` (SQL)
  - `functions/` (Edge Functions)
  - `indexer/` (worker)
  - `cron/` (notify_scheduler, bot_sender)
  - `README.md`
- `bot/`
  - source + `README.md`
- `miniapp/`
  - source + `README.md`
- `docs/` (specs + test packs)

## 4) Milestones (clear gates, no skipping)

### M0 — Foundations & Decisions (0.5–2 days)
**Goal:** lock spec + decide security-critical points to avoid "tear down and rebuild".
- [x] Finalize anti-spoof approach: **Option A (TEP-89 `jetton_wallet`)**.
- [x] Finalize dust policy: **no orphan dust** (all remainders go to `treasury_owed`).
- [x] Finalize withdraw destination: fixed to `msg.sender` (anti-phishing; no arbitrary destination).
- [x] Finalize key management: `GUARDIAN` ed25519, `TREASURY_OWNER`, deployer, `testnet/mainnet`.
- [x] Finalize caps/guardrails for MVP (N<=12, pot cap, max_discount, grace, windows).
**Exit gate:** no "open decisions" affecting contract logic before coding.

### M1 — Smart Contract v1.2.1 + Tests (1–2 weeks)
**Goal:** contract implementable + testable + passes attack pack.
- Deliverables:
  - [x] `contracts/CircleContract.tact`
  - [x] `tests/` (unit + adversarial)
  - [x] `contracts/README.md` (deploy/init/verify/test)
  - [x] `scripts/` (deploy/init/verify; repeatable)
- Exit gates (P0):
  - [x] Pass `docs/SECURITY_TESTS.md` via `npm test` (attack pack implemented).
  - [x] Prove invariants (asserts + tests) and time gates half-open.
  - [x] Anti-spoof deposit test: fake notify / wrong sender / wrong master all fail.
  - [x] Withdraw modes correct: Active only allows `withdrawable` (mode=1), Recruiting exit (mode=3), end state withdraws all (mode=2).
  - [x] Terminate default seize correct (no "defaulter escape", no divide-by-zero, no negative vesting).

### M2 — Backend (Supabase BFF) + Indexer + Cron (1–2 weeks)
**Goal:** non-custodial backend runs end-to-end with contract.
- Deliverables:
  - [x] SQL schema + migrations (v1.2.1 compatible)
  - [x] Edge Functions: auth Telegram, group verify, wallet proof, join ticket, circle status
  - [x] Idempotent indexer (call get methods + upsert mirrors)
  - [x] Cron: notify_scheduler + bot_sender (dedupe + backoff)
  - [x] Monitoring/alerts primitives (indexer last_ok/error + optional ops DM)
- Exit gates (P0):
  - [x] No exposed secrets; no raw initData logging; rate limit critical endpoints.
  - [x] Wallet proof challenge/response correct (no plain text binding).
  - [x] Join ticket domain-separated + anti-replay (nonce + exp).
  - [x] Indexer updates based on chain truth (upsert), rerun-safe.

### M3 — Telegram Bot MVP (3–7 days)
**Goal:** bot sends correct on-chain schedule reminders, no spam/harassment.
- Deliverables:
  - [x] Commands: `/circle`, `/status`, `/help`
  - [x] Message templates (English) + edit/pin strategy (join post + progress via edit)
  - [x] 429 backoff + max 2 tags per user per cycle (no tagging in MVP reminders)
- Exit gates:
  - [x] No spam: progress uses edit; reminders deduplicated.
  - [x] Neutral content (no-shame).

### M4 — Telegram Mini App MVP (1–2 weeks)
**Goal:** UI + TonConnect flows correctly map to contract rules.
- Deliverables:
  - [x] Join flow: accept rules → wallet proof → join ticket → on-chain join
  - [x] Deposit collateral/prefund (payload purpose) + status
  - [x] Auction commit/reveal + salt storage + countdown
  - [x] Withdraw screen mode-based (1/2/3)
- Exit gates (P0):
  - [x] UI must not "promise withdrawals" from buckets that contract locks (Active only allows payout).
  - [x] On-chain timestamps displayed on all critical screens.
  - [x] Clear error taxonomy to reduce support tickets.

### M5 — E2E Testnet Pilot (2–4 weeks)
**Goal:** run 10 circles on testnet end-to-end, measure metrics, 0 critical bugs.
- Exit gates:
  - [ ] ≥ 70% commit+reveal success in pilot.
  - [ ] 0 incidents of money loss; settlement correct; terminate correct.
  - [ ] Support load ≤ 10 tickets/day.

### M6 — Mainnet Beta (small cap + whitelist)
**Goal:** safe mainnet beta, small blast radius.
- Exit gates:
  - [ ] Whitelist leaders, pot cap $100–$500/cycle.
  - [ ] EmergencyStop playbook + comms ready.
  - [ ] Monitoring active; indexer lag alert stable.

## 5) Work Breakdown Structure (WBS) — by module

### 5.1 Smart Contract (SC-*)

**SC-00 — Toolchain & scaffolding**
- [x] Confirm toolchain: `tact` compile + `@ton/sandbox` + `vitest` (already in `package.json`).
- [x] `npm test` runs repeatably (compile + tests).
- [x] Setup CI to run `npm test` (GitHub Actions).

**SC-01 — Config & storage**
- [x] Implement config fields per v1.2.1 (`jetton_master`, `guardian_pubkey`, bps, caps, windows…).
- [x] Storage layout: Global + Member + Cycle per `docs/BUILD_GUIDE.md`.
- [x] `treasury_owed` includes fee + penalties + **dust remainder** (no orphan dust).

**SC-02 — Anti-spoof Jetton deposits (security-critical)**
- [x] Implement Option A (TEP-89) or Option B (derive).
- [x] Reject/ignore correctly: wrong sender, wrong master, amount<min_deposit_units, non-member.
- [x] Robust payload parsing: if malformed → default PREFUND.

**SC-03 — Join ticket & Recruiting**
- [x] `JOIN_WITH_TICKET` verify signature + nonce anti-replay + exp.
- [x] Auto-lock when reaching N members.
- [x] `WITHDRAW(mode=3)` Recruiting exit: swap-with-last + reset buckets + refund deposits.

**SC-04 — Lock & cycle init**
- [x] Compute `pot`, `collateral_required`, enforce `max_pot_cap`.
- [x] Init cycle1: timestamps, `due_remaining[m]=C`, reset maps.

**SC-05 — Funding engine**
- [x] Half-open window: `due_at <= now < grace_end_at`.
- [x] `_debitOne` idempotent via `due_remaining`.
- [x] Auto-heal collateral shortage from `prefund` then `credit` before gate.
- [x] Late penalty applied once per flag.
- [x] `TRIGGER_DEBIT_ALL` spam-safe.

**SC-06 — Auction (commit–reveal)**
- [x] Commit: domain-separated hash, commit once, order counter.
- [x] Reveal: verify hash + bounds by `max_discount_bps`.
- [x] Phase sync: commit→reveal when `now>=commit_end`.

**SC-07 — Finalize & settlement**
- [x] Non-reveal penalty applied once.
- [x] Winner selection deterministic + fallback linear probe avoiding `has_won=true`.
- [x] Settlement math: fee→`treasury_owed`, vesting+future lock (cycle 1), immediate→`withdrawable`.
- [x] Discount credit distribution + remainder policy (no orphan dust).
- [x] Rollover cycle or complete.

**SC-08 — Default & terminate**
- [x] DefaultEligible when `now >= grace_end_at` and not fully funded.
- [x] `TERMINATE_DEFAULT`:
  - refund paid_this_cycle → prefund
  - defaulter predicate correct: `due_remaining>0 OR collateral<required`
  - seize: collateral capped + future_locked + credit + withdrawable + vesting_unreleased
  - reset vesting safely (no negative values)
  - distribute penalty_pool; `rc==0` routes to `treasury_owed`

**SC-09 — Withdrawals**
- [x] `WITHDRAW(mode=1)` payout-only: allowed in Active/ending states, only drains `withdrawable`.
- [x] `WITHDRAW(mode=2)` all: only in Completed/Terminated/EmergencyStop; `vesting_unreleased=max(0, locked-released)`.
- [x] Outbox + onBounce restore (bounce-safe jetton transfers).
- [x] `WITHDRAW_TREASURY` pull-based.

**SC-10 — EmergencyStop**
- [x] Guardian signature + nonce anti-replay.
- [x] Enforce freeze: all ops except withdraw must `require(status != EmergencyStop)`.

**SC-11 — Get methods (UI/indexer)**
- [x] `get_config()`, `get_status()`, `get_members()`, `get_member(address)` (N is small).

### 5.2 Backend (BE-*)

**BE-00 — Supabase project bootstrap**
- [x] Migrations skeleton + local dev flow.
- [x] Secrets & env var map (service role key, bot token, guardian private key).

**BE-01 — Auth & sessions**
- [x] Verify Telegram WebApp initData correctly.
- [x] Issue `session_token` + store `sessions` (expiry).
- [x] Do not log initData/raw secrets.

**BE-02 — Social anchor (group verify)**
- [x] `getChatMember` verify user in group.
- [x] Handle banned/left cases.

**BE-03 — Rules acceptance**
- [x] Store `rules_signature_hash`, block wallet bind if not accepted.

**BE-04 — Wallet proof (TonConnect)**
- [x] challenge/response: nonce + exp + message.
- [x] verify signature; enforce wallet uniqueness policy (MVP: 1 tg_uid ↔ 1 wallet).

**BE-05 — Join ticket issuance**
- [x] Preconditions: verified_in_group + accepted_rules + wallet_verified + circle Recruiting + contract_address set.
- [x] Sign message domain-separated; store nonce + exp; mark used via indexer later.

**BE-06 — Indexer (idempotent, chain-truth)**
- [x] Mirror state via get methods (`get_status`, `get_members_count`, `get_member_at`, `get_member`) and upsert mirrors (chain truth).
- [x] Provider fallback + retry/backoff; ops fields (`last_indexed_at`, `last_indexer_error`) updated for alerts.
- [ ] (Optional) Tx list polling for analytics/debug (not required for mirror correctness).

**BE-07 — Notifications & bot sender**
- [x] notify_scheduler: enqueue reminders based on on-chain timestamps + dedupe_key.
- [x] bot_sender: send/edit/pin; 429 backoff; drop non-critical.

**BE-08 — Monitoring**
- [x] Structured logs (minimum): request_id/circle_id/provider/lag on errors; store last indexer attempt/success/error.
- [x] Alerts (minimum): indexer lag + indexer errors via `ops-health-check` + notifications queue.

### 5.3 Bot (BOT-*)
- [x] Commands + templates + anti-spam edit strategy.
- [x] Status summaries use on-chain timestamps (from indexer mirror).
- [x] Rate limit/429 handling.

### 5.4 Mini App (APP-*)
- [x] Auth bootstrap (initData → session).
- [x] Join flow (S3–S6): rules → wallet proof → ticket → on-chain join.
- [x] Deposit (S7): payload purpose + forward TON requirement copy.
- [x] Dashboard (S2): status + timestamps + balances mirror + CTAs per withdraw mode.
- [x] Auction (S8–S10): commit/reveal, salt localStorage, countdown, error states.
- [x] Withdraw (S11): mode-based confirmations; do not let user choose destination if contract doesn't validate.

## 6) Testing & Quality Gates (must-pass)

### 6.1 Contract test matrix (minimum)
- [x] Double debit spam 100x: does not deduct more than C.
- [x] Debit outside window: fails.
- [x] Boundary `now == grace_end_at`: debit fails, terminate allowed.
- [x] Winner withdrawable in Active: `WITHDRAW(mode=1)` ok; cannot withdraw other buckets.
- [x] Defaulter cannot withdraw safety lock after terminate.
- [x] Auto-heal collateral prevents false default when prefund is sufficient.
- [x] Fallback winner never selects `has_won=true`.
- [x] Recruiting exit refunds deposits; members_count decreases; swap-with-last correct.
- [x] Fake jetton notify/sender/master: ignored/rejected.

### 6.2 Backend test matrix (minimum)
- [ ] Telegram initData verify: valid/invalid/expired.
- [ ] Wallet proof: replay nonce fails; wrong signature fails.
- [ ] Ticket issue: only when preconditions met; exp/nonce enforced.
- [ ] Indexer idempotent: rerun does not double-apply; mirrors match get methods.
- [ ] Notifications dedupe + 429 backoff behavior.

### 6.3 E2E tests (testnet)
- [ ] Happy path: create → N join → lock → deposits → funding → commit/reveal → finalize → winner withdraw (mode=1).
- [ ] Grace recovery: underfund → topup in grace → funded → proceed.
- [ ] Default terminate: after grace_end, terminate → non-defaulters withdraw all (mode=2).
- [ ] EmergencyStop: freeze + withdraw allowed.

## 7) Definition of Done (DoD)

### 7.1 Contract DoD
- [x] Implement per v1.2.1, pass attack pack, pass invariants/time gates.
- [x] Anti-spoof deposits + replay protection + correct withdraw modes.
- [x] Deploy/init/verify steps documented + reproducible.

### 7.2 Backend DoD
- [x] Non-custodial, secrets safe, rate limits, idempotent indexer.
- [x] Bot reminders based on on-chain timestamps, dedupe ok.
- [x] Monitoring & incident alerts working (minimum viable ops alerts).

### 7.3 Product DoD (MVP)
- [ ] 10 circles on testnet run end-to-end; ≥70% commit+reveal; 0 critical bugs.
- [ ] Mainnet beta readiness: cap + whitelist + playbooks + monitoring.

## 8) Open Decisions (must close at M0)
- [x] Anti-spoof: **Option A (TEP-89)** with `jetton_wallet` discovery + strict sender check.
- [x] Withdraw destination: fixed to `msg.sender` (no arbitrary destination).
- [x] Dust handling: all remainders go to `treasury_owed` (no orphan dust).
- [x] Vesting release: **hold until end** (no release-as-credit in MVP to minimize complexity).
- [x] Indexer approach: call contract get methods (upsert from chain truth).

## 9) Change control (to protect safety)
- Any change related to **money/time gates/anti-spoof/withdraw** must:
  1) update spec in `docs/` first,
  2) update tests first or simultaneously,
  3) update `MASTER_PLAN.md` (scope + gate) if affecting milestone/DoD.

## 10) Metrics & Instrumentation (measure from day 1)

> Goal: catch drift/bugs early, reduce support, and have "early warning" for No-loss incidents.

### 10.1 North-star & safety
- `incident_count` (target = 0).
- `emergency_stop_count` (target = 0; >0 is escalation).
- `settlement_error_count` / `terminate_error_count`.

### 10.2 Activation funnel (MVP)
- Join link click → open mini app
- Verified in group → accept rules
- Wallet proof success
- Ticket issued
- On-chain join success
- Collateral deposit success
- Prefund ≥ C success

### 10.3 Engagement/health per circle
- `% funded before due_at`, `% funded within grace`
- `% commit`, `% reveal`, `% non-reveal`
- `time_to_funding`, `time_to_commit`, `time_to_reveal`
- `default_rate`, `terminate_rate`

### 10.4 Reliability (ops)
- Indexer lag (seconds) per contract; alert if `> 300s`.
- Provider fail rate (TonAPI/Toncenter) + fallback count.
- Bot send/edit fail rate; 429 count.

### 10.5 Instrumentation implementation (backend)
- Structured logs required: `request_id`, `circle_id`, `tg_user_id`, `wallet`, `tx_hash`, `provider`, `error_code`.
- DB mirror always "chain-truth": indexer writes via `get_*` methods (upsert), no cumulative deltas.
- (Optional) `events` table: store funnel events for analytics; if not available, use logs + Postgres views.

## 11) Ops Playbooks (solo-friendly)

### 11.1 EmergencyStop runbook (P0)
Trigger when signs appear: wrong payout, spoof deposit, double debit/settle, serious indexer/provider drift.
1) Freeze: call `EMERGENCY_STOP` on affected circles.
2) Disable create/join ticket in backend (feature flag).
3) Broadcast (group): "Funds safe, investigating. Withdrawals available per rules."
4) Contain: pause auction reminders; keep only status updates.
5) Diagnose: identify contract(s), tx(s), window(s), reproducible case.
6) Recover: patch + redeploy (new circle) or guide withdraw/terminate per rules.
7) Postmortem: document root cause + new test case + update spec/docs.

### 11.2 Indexer lag / provider outage
- Switch to fallback provider after N failures; exponential backoff.
- UI degrade: show "chain sync delayed" + allow user manual refresh.
- Alert when lag > 5 minutes; if > 30 minutes: treat as incident (freeze create).

### 11.3 Bot 429 / spam risk
- On 429: backoff + drop non-critical reminders first.
- Strict: edit existing messages, do not spam new messages.
- Tag limit: max 2 times per user per cycle (enforced server-side).

## 12) Security checklist (pre-mainnet)

### 12.1 Contract
- Anti-spoof deposits (trusted wallet + correct opcode/master) + tests.
- Half-open windows (`due_at <= now < grace_end_at`) + boundary tests.
- Idempotency: due_remaining, settled flag, penalty flags, nonce replay maps.
- Pull payouts + bucket reset before transfer + (if used) outbox bounce restore.
- Terminate default: seize escape buckets; `rc==0` guard; no orphan dust.
- EmergencyStop enforce: block ops except withdraw.

### 12.2 Backend
- Telegram initData verify correctly; do not log raw data.
- Wallet proof challenge/response + expiry + anti-replay.
- Join ticket domain-separated + unique nonce + exp.
- Rate limits on critical endpoints; secrets not exposed.
- Indexer idempotent; mirrors match get methods; alerts working.

### 12.3 UI/Bot
- UI does not "unlock" buckets against rules; withdraw CTA matches mode per status.
- Bot no harassment/spam; 429 backoff.

## 13) Risk register (top risks + mitigation)

1) **Jetton spoof / fake notify** → Mitigation: Option A/B fully + tests "wrong sender/master/opcode".
2) **Withdraw transfer fail/bounce mismatch** → Mitigation: outbox pattern + onBounce restore + tests.
3) **Window edge overlap (grace_end)** → Mitigation: half-open windows + boundary tests.
4) **Defaulter escape via locked buckets** → Mitigation: terminate seize + withdraw modes + tests.
5) **Indexer drift (DB != chain)** → Mitigation: read get methods + upsert; lag alert; no manual "fix DB".
6) **UI misleads withdrawals** → Mitigation: CTA gating by status + on-chain values; E2E tests.
7) **Bot banned due to spam** → Mitigation: edit/pin strategy; 429 handling; tag caps.
