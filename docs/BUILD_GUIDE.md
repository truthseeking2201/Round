# MoneyCircle – Engineering Build Guide
Version: v1.2.1 (Hardened + Logic Bomb Fix Pack)
Audience: Engineering Team / Solo Founder
Goal: Implement 3 components in order:
  (1) Smart Contract (Core) -> (2) Backend (Support) -> (3) Bot & Mini App (UI)

---

## How to use this doc (IMPORTANT)
- Execution plan (scope, milestones, gates): `MASTER_PLAN.md`
- This doc is the single source of truth for implementation.
- Do NOT invent new behavior. If something is unclear, add a TODO + propose safest default.
- Security-first: prefer pull-based payouts, idempotent state transitions, and on-chain time gates.
- All money-moving code must have:
  - explicit preconditions
  - explicit postconditions
  - idempotency guards
  - deterministic rounding policy
- Treat **contract** as truth for balances and time windows. Backend is non-custodial.

---

# PART 1 — SMART CONTRACT (CORE)
Target: TON + USDT Jetton, Tact (or FunC but prefer Tact)
Contract model: 1 Circle = 1 Contract

## 1. Deliverables (Contract)
You must produce:
1) `CircleContract.tact` (or equivalent) implementing:
   - Join by signed ticket (domain-separated + nonce anti-replay)
   - Lock circle automatically when members_count == N
   - Deposits: collateral/prefund via Jetton transfer_notification with anti-spoof validation
   - Funding: on-chain due/grace windows, idempotent debit (due_remaining)
   - Auction: commit–reveal with on-chain windows, non-reveal penalty, deterministic tie-break
   - Finalize & settlement: fee, vesting, safety lock, credit distribution, dust policy
   - Default terminate after grace_end: refund + seize + distribute, pull withdrawals
   - EmergencyStop: freeze everything except withdrawals
   - Withdraw modes (fix liquidity trap + recruiting deadlock)
2) `tests/`:
   - Unit tests
   - Adversarial / attack test pack (spam, replay, spoof, edge windows)
3) `README.md`:
   - Deploy steps, init steps, test steps
   - Known limits (N<=12, pot cap)
   - Safety disclaimers & audit checklist

---

## 2. Core invariants (MUST HOLD)
### Balance & state invariants
- pot = N * C (constant after lock)
- pot_pool <= pot always
- due_remaining[m] >= 0 always
- funded_count <= N always
- settlement runs at most once per cycle (`settled == true`)
- penalties applied at most once (`late_penalty_applied`, `non_reveal_penalty_applied`)
- No function allows guardian/leader to withdraw users' funds (guardian only freeze)

### Time gate invariants (fix overlap bug)
Use **exclusive grace end**:
- Debit allowed: `due_at <= now < grace_end_at`
- Terminate allowed: `now >= grace_end_at`
- Commit allowed: `now < commit_end_at`
- Reveal allowed: `now < reveal_end_at`
- Finalize allowed: `now >= reveal_end_at`

### EmergencyStop enforcement
All ops except withdrawals must check:
- `require(status != EmergencyStop)`

---

## 3. Contract parameters (Config)
Required immutable config:
- jetton_master: Address (USDT)
- guardian_pubkey: uint256
- treasury_owner: Address
- n_members: uint16 (<=12)
- contribution: int (units)
- total_cycles: uint16 (default=N)
- interval_sec: uint32 (7d or 30d)
- grace_sec: uint32 (24h)
- take_rate_bps: uint16 (100=1%)
- collateral_rate_bps: uint16 (1000=10%)
- max_discount_bps: uint16 (500=5%)
- vesting_bps_cycle1: uint16 (2000=20%)
- early_lock_rate_bps_cycle1: uint16 (3000=30%)
- commit_duration_sec: uint32 (1800)
- reveal_duration_sec: uint32 (1800)
- max_pot_cap: int (cap pot)
- min_deposit_units: int (anti-spam; recommend >= 0.1 USDT)

---

## 4. Storage layout (v1.2.1)
### Global state
- status: Recruiting | Locked | Active | Completed | Terminated | EmergencyStop
- members_count: uint16
- current_cycle: uint16
- pot: int
- collateral_required: int
- member_list: Address[] (mutable in Recruiting; frozen after Locked)
- members: map<Address, Member>

- treasury_owed: int (includes fee + penalties + dust remainder)
  NOTE: **No orphan dust**: do NOT keep separate dust_reserve unless treasury withdraws it too.

- used_nonces: map<uint256,bool> (anti replay for tickets + emergency)

### Member structure
- active: bool
- has_won: bool

- collateral: int
- prefund: int
- credit: int

- vesting_locked: int
- vesting_released: int
- future_locked: int

- withdrawable: int  (PAYOUT bucket; must be withdrawable in Active)

### Cycle state
- cycle_index: uint16
- phase: Funding | Commit | Reveal | Settling | Done | DefaultEligible

- cycle_start_at: uint32
- due_at: uint32
- grace_end_at: uint32
- commit_start_at: uint32
- commit_end_at: uint32
- reveal_end_at: uint32

- funded_count: uint16
- pot_pool: int

- due_remaining: map<Address,int>
- paid_this_cycle: map<Address,int>

- late_penalty_applied: map<Address,bool>
- non_reveal_penalty_applied: map<Address,bool>

- commit_hash: map<Address,int>
- commit_order: map<Address,uint16>
- commit_counter: uint16

- revealed: map<Address,bool>
- payout_wanted: map<Address,int>

- settled: bool

---

## 5. Opcodes & payload formats
### Jetton deposit purpose (forward payload)
Keep tiny & robust:
- MAGIC:uint32 = 0xC0FFEE01
- purpose:uint8
  - 1 = COLLATERAL
  - 2 = PREFUND
If malformed -> default to PREFUND.

### Contract opcodes
- 0x1001 JOIN_WITH_TICKET
- 0x2001 TRIGGER_DEBIT_ALL
- 0x3001 COMMIT_BID
- 0x3002 REVEAL_BID
- 0x3003 FINALIZE_AUCTION
- 0x4001 TERMINATE_DEFAULT
- 0x6001 WITHDRAW  (mode-based!)
- 0x7001 WITHDRAW_TREASURY
- 0x9001 EMERGENCY_STOP

### WITHDRAW mode (Fix #1 + #5)
`WITHDRAW(mode:uint8)`
- mode=1: WITHDRAW_PAYOUT_ONLY (allowed in Active if withdrawable>0)
- mode=2: WITHDRAW_ALL (only Completed/Terminated/EmergencyStop)
- mode=3: RECRUITING_EXIT (only Recruiting; exit + withdraw deposits)

---

## 6. Security-critical: Jetton anti-spoof validation
You MUST ensure deposit events cannot be spoofed.
Two safe approaches:

### Option A (recommended): Accept only transfer_notification from the contract's jetton wallet
- Track `jetton_wallet` address of THIS contract (owner=contract).
- Only accept transfer_notification if `msg.sender == jetton_wallet`.
- This requires an init step (TEP-89) in deploy pipeline to discover/set contract jetton wallet.

### Option B: Deterministically compute expectedJettonWallet(owner)
- Store jetton_wallet_code and derive expected wallet address from (owner, jetton_master).
- Accept notification if `msg.sender == expectedJettonWallet(from_owner)`.

Pick ONE, implement fully, and add tests for spoof attempts.

---

## 7. Function specs (v1.2.1 patched)
### 7.1 JOIN_WITH_TICKET(wallet, exp, nonce, sig)
Signed message:
`H("MC_JOIN"|contract_address|wallet|exp|nonce)`
Pre:
- status == Recruiting
- now <= exp
- signature valid (guardian_pubkey)
- used_nonces[H(wallet|nonce)] == false
- members_count < N
Post:
- mark nonce used
- add member(active=true)
- append to member_list
- members_count++
- if members_count == N -> LOCK

### 7.2 LOCK (auto)
Pre:
- members_count == N
- pot = N*C <= max_pot_cap
Post:
- status=Locked
- collateral_required = pot*collateral_rate_bps/10000
- init cycle 1 (Funding):
  - cycle_start_at = now
  - due_at = now + interval_sec
  - grace_end_at = due_at + grace_sec
  - phase=Funding
  - due_remaining[m]=C for all
  - paid_this_cycle[m]=0
  - funded_count=0, pot_pool=0

### 7.3 Deposit handler (COLLATERAL/PREFUND)
Pre:
- status not EmergencyStop
- sender must be active member
- amount >= min_deposit_units
Apply:
- collateral += amount (purpose=1)
- prefund += amount (purpose=2)
Auto-debit-on-deposit:
- if phase Funding AND due_at <= now < grace_end_at:
  - call _debitOne(sender)
  - if funded_count==N -> open commit window

### 7.4 _debitOne(member) — Idempotent + auto-heal collateral (Fix #3)
Pre:
- phase Funding
- due_at <= now < grace_end_at
- due_remaining[member] > 0

Step 0: **Auto-heal collateral BEFORE gate**
missing = collateral_required - collateral
if missing > 0:
  - take from prefund first
  - then take from credit
  - add into collateral

Gate:
- if collateral < collateral_required: return (still insufficient)

Debit order:
- use credit -> use future_locked -> use prefund
- paid = min(need, available)
- update due_remaining, paid_this_cycle, pot_pool
- if due_remaining becomes 0 -> funded_count++

Late penalty:
- apply once if now > due_at and user becomes funded in grace
- take penalty from collateral (cap it)
- treasury_owed += penalty

### 7.5 triggerDebitAll()
Pre:
- phase Funding
- due_at <= now < grace_end_at
Loop all members: _debitOne
If funded_count==N:
- assert pot_pool == pot
- open commit window (set once)

### 7.6 Open commit window
Pre:
- funded_count==N
- commit_start_at == 0
Post:
- status=Active
- phase=Commit
- commit_start_at=now
- commit_end_at=now + commit_duration
- reveal_end_at=commit_end_at + reveal_duration

### 7.7 Commit bid
Pre:
- status not EmergencyStop
- phase Commit
- now < commit_end_at
- funded (due_remaining==0)
- has_won==false
- not committed
Post:
- store commit_hash
- store commit_order (increment commit_counter)

### 7.8 Reveal bid
Pre:
- phase Reveal (auto sync if now>=commit_end_at)
- now < reveal_end_at
- committed, not revealed
- verify commit hash:
  H("MC_BID"|contract|cycle|wallet|payoutWanted|salt)
- bounds: pot*(1-max_discount) <= payoutWanted <= pot
Post:
- revealed=true; payout_wanted=...

### 7.9 Finalize auction (Fix #4 + non-reveal)
Pre:
- phase Reveal
- now >= reveal_end_at
- settled==false
- pot_pool==pot

Non-reveal:
- committed but not revealed -> treat payoutWanted=pot, apply penalty once, treasury_owed += penalty

Winner:
- if any revealed: min payoutWanted, tie-break commit_order then address
- else fallback: **linear probe** from (cycle_index-1)%N to find first member with has_won==false
  - if not found -> revert ALL_MEMBERS_ALREADY_WON

Settlement:
- fee -> treasury_owed (include remainder; avoid orphan dust)
- vesting (cycle 1): holdback -> vesting_locked
- safety lock (cycle 1): lock part into future_locked
- immediate -> withdrawable (available to withdraw in Active)
- credit distribution: discount/(N-1) -> credit for others
- has_won=true for winner
- mark settled=true
- rollover or complete

### 7.10 Terminate default (Fix #2 + divide-by-zero guard)
Pre:
- phase DefaultEligible (set when now>=grace_end_at and not funded)
- now >= grace_end_at

Step 1 refund:
- paid_this_cycle -> prefund for each member
- pot_pool=0

Step 2 seize from defaulters:
defaulter = (due_remaining>0) OR (collateral < collateral_required)
seize:
- slash_collateral = min(collateral, collateral_required)
- slash_future = future_locked
- slash_credit = credit
- slash_withdrawable = withdrawable   (recommended yes)
- slash_vesting = max(0, vesting_locked - vesting_released)
reset those buckets to 0 safely (avoid negative vesting)
penalty_pool += sum(slashes)

Step 3 distribute penalty_pool:
recipients = NOT defaulter
if recipients_count==0:
  treasury_owed += penalty_pool
else:
  per = penalty_pool/rc; rem = penalty_pool%rc
  recipients.prefund += per
  treasury_owed += rem   (avoid orphan dust)

status=Terminated

### 7.11 Withdraw (mode-based) (Fix #1 + #5)
WITHDRAW(mode)
- mode=1 (PAYOUT_ONLY):
  - allowed when status in {Active, Completed, Terminated, EmergencyStop}
  - transfer only `withdrawable`, set withdrawable=0
  - do NOT touch collateral/prefund/credit/future_locked/vesting

- mode=2 (ALL):
  - allowed when status in {Completed, Terminated, EmergencyStop}
  - withdraw: collateral + prefund + credit + withdrawable + future_locked + max(0, vesting_locked-vesting_released)
  - set all to 0

- mode=3 (RECRUITING_EXIT):
  - allowed when status==Recruiting
  - remove member from member_list (swap-with-last) + members_count--
  - set member.active=false
  - withdraw collateral+prefund only, reset buckets to 0

### 7.12 Withdraw treasury
- withdraw treasury_owed to treasury_owner
- treasury_owed=0

### 7.13 Emergency stop
- signature domain-separated + nonce anti-replay
- set status=EmergencyStop
- block all ops except withdraw & withdraw_treasury

---

## 8. Test plan (MUST)
Implement automated tests for:
- Double debit spam (100x trigger)
- Deposit spoof attempt (fake notify)
- Grace boundary (now == grace_end_at behavior)
- Winner withdrawable in Active (mode=1)
- Defaulter cannot withdraw future_locked after terminate
- Collateral auto-heal prevents false default
- Fallback winner never repeats has_won
- Recruiting exit refunds deposits

---

# END PART 1 — SMART CONTRACT
Next: Backend (Support) – Supabase schema, Edge Functions, ticket signing, indexer, monitoring.

# PART 2 — BACKEND (SUPPORT)
Stack recommended:
- Supabase (Postgres + Edge Functions + Scheduled Functions)
- TypeScript (Deno for Edge Functions)
- Indexer Worker: can be Supabase Scheduled Function OR external Node service (recommended for reliability)
- Provider: TonAPI primary, Toncenter fallback

Backend responsibilities (NON-CUSTODIAL):
1) Verify Telegram WebApp initData -> issue backend session token
2) Verify group membership (Telegram Bot API getChatMember)
3) Verify wallet ownership (TonConnect proof challenge/response)
4) Issue Join Ticket (guardian signature)
5) Index on-chain events + mirror to DB
6) Notifications scheduling + Bot sending (batch/edit)
7) Monitoring + alerting

Backend must NEVER:
- hold user funds
- decide due/grace/auction windows (read from chain)
- "fix" balances by editing DB to differ from chain

---

## 1) Environment variables / Secrets (MUST)
### 1.1 Supabase
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY  (server-only)
- SUPABASE_JWT_SECRET (if you self-sign JWT)

### 1.2 Telegram
- TELEGRAM_BOT_TOKEN
- TELEGRAM_BOT_USERNAME
- TELEGRAM_WEBAPP_SECRET (for initData verification)

### 1.3 TON providers
- TONAPI_KEY (optional)
- TONCENTER_KEY (optional)
- TON_PROVIDER_PRIMARY = "tonapi"
- TON_PROVIDER_FALLBACK = "toncenter"

### 1.4 Guardian signing key (CRITICAL)
- GUARDIAN_PRIVATE_KEY (ed25519)  **server-only**
- GUARDIAN_PUBKEY (store to compare / debug)

Security rules:
- never expose GUARDIAN_PRIVATE_KEY to client
- never log secrets
- rotate keys with playbook (future P1)

---

## 2) Data Model (Supabase schema) — v1.2.1 compatible
NOTE: DB is mirror for UX. On-chain is truth.

### 2.1 Tables (minimal MVP)
#### `tg_users`
- telegram_user_id (bigint, unique)
- username, first_name, last_name, photo_url, language_code
- risk_flags jsonb
- created_at, updated_at

#### `tg_groups`
- group_chat_id (bigint, unique)
- title, type
- bot_present boolean
- bot_admin boolean
- last_checked_at

#### `sessions`
- session_token (text pk)  OR (uuid)
- telegram_user_id (bigint)
- group_chat_id (bigint nullable)
- expires_at timestamptz
- created_at

#### `circles`
- circle_id (uuid pk)
- group_chat_id
- leader_user_id
- status (Recruiting/Locked/Active/Completed/Terminated/EmergencyStop)
- contract_address (text)
- jetton_master (text)  (USDT master)
- config snapshot: N, C, interval_sec, grace_sec, bps (take/collateral/discount/vesting/lock), pot_cap
- current_cycle_index (int)
- onchain_due_at (timestamptz)
- onchain_grace_end_at (timestamptz)
- onchain_commit_end_at (timestamptz)
- onchain_reveal_end_at (timestamptz)
- onchain_phase (int)  (mirror; cycle phase code)
- onchain_funded_count (int)  (mirror; # funded in current cycle)
- onchain_jetton_wallet (text)  (mirror; contract’s USDT Jetton wallet; required for safe deposits)
- created_at, updated_at

NOTE: Mirror columns are added by `backend/migrations/004_onchain_mirror_fields.sql`.

#### `circle_members`
- circle_id
- telegram_user_id
- wallet_address (text)
- join_status (joined/accepted_rules/wallet_verified/ticket_issued/onchain_joined/exited)
- rules_signature_hash (text)
- has_won (bool)
- mirror balances:
  - collateral, prefund, credit, vesting_locked, vesting_released, future_locked, withdrawable, due_remaining
- created_at, updated_at
UNIQUE(circle_id, telegram_user_id)
INDEX(circle_id, wallet_address)

#### `wallet_bindings` (optional but recommended)
- telegram_user_id
- wallet_address
- verified_at
UNIQUE(wallet_address)
UNIQUE(telegram_user_id)

#### `join_tickets`
- circle_id
- telegram_user_id
- wallet_address
- exp (timestamptz)
- nonce (text or bigint)
- sig (text/base64)
- used boolean
- issued_at
UNIQUE(circle_id, wallet_address, nonce)

#### `chain_events`
- id (uuid)
- contract_address
- tx_hash
- lt (bigint)
- event_type
- payload jsonb
- idempotency_key UNIQUE  (contract:lt:event_type)
- processed boolean
- processed_at
- processing_error text

#### `bot_messages`
- group_chat_id
- circle_id
- message_type (JoinPost/Progress/Auction/Settlement/Default/Emergency)
- message_id (bigint)
- pinned boolean
- last_edited_at

#### `notifications_queue`
- id (uuid)
- target_type (group/dm)
- group_chat_id nullable
- telegram_user_id nullable
- circle_id
- cycle_index nullable
- kind (due_reminder/auction_open/reveal_reminder/settlement/default/emergency)
- payload jsonb
- scheduled_at
- status (pending/sent/failed)
- fail_reason
- dedupe_key UNIQUE

---

## 3) RLS & Access model (simple & safe)
Recommended MVP:
- Turn on RLS for all tables
- Client NEVER queries DB directly
- All reads/writes happen via Edge Functions with service role

If you must expose read-only endpoints:
- create views with limited columns
- enforce auth via session_token in Edge Functions

---

## 4) Edge Functions (API/BFF) — required endpoints
### 4.1 Auth: Telegram initData
#### `POST /auth/telegram`
Input: { initData }
Steps:
1) Verify initData signature (Telegram WebApp standard)
2) Extract telegram_user, group_chat_id (if opened in group)
3) Upsert `tg_users`, `tg_groups`
4) Issue `session_token` (random string) + store `sessions` (24h expiry)
Output: { session_token, user, group }

Errors:
- TG_INITDATA_INVALID
- TG_INITDATA_EXPIRED

### 4.2 Group membership verify (social anchor)
#### `GET /group/verify?circle_id=...`
Auth: session_token
Steps:
- Look up circle.group_chat_id
- Call Telegram Bot API getChatMember(group_id, user_id)
Return: { verified: true/false, role }
Errors:
- TG_NOT_IN_GROUP
- TG_BANNED
- BOT_NOT_IN_GROUP (if bot absent)

### 4.3 Create circle (backend-side only)
#### `POST /circles`
Auth: session_token
Body: { name?, n_members, contribution_usdt, interval (weekly/monthly) }
Steps:
- verify bot present + caller is group member
- enforce caps: pot <= max_pot_cap
- create circle row (Recruiting)
- (deployment may be separate step) store contract_address once deployed
- bot post join link (save message_id)
Return: circle summary

### 4.4 Accept rules
#### `POST /circles/:id/accept_rules`
Auth: session_token
Body: { rules_signature_hash }
Update circle_members.join_status="accepted_rules"

### 4.5 Wallet proof (TonConnect ownership)
#### `POST /wallet/bind_challenge`
Auth: session_token
Body: { circle_id }
Return: { nonce, exp, message_to_sign }
message_to_sign: `MC_BIND|tg_uid|circle_id|nonce|exp`

#### `POST /wallet/bind_confirm`
Auth: session_token
Body: { circle_id, wallet_address, signature, nonce, exp }
Verify signature matches message_to_sign.
Enforce:
- wallet not bound to other user
- tg_uid binds only one wallet (MVP)
Update:
- wallet_bindings
- circle_members.wallet_address
- join_status="wallet_verified"

Errors:
- WALLET_PROOF_INVALID
- WALLET_ALREADY_BOUND
- WALLET_BIND_EXPIRED

### 4.6 Issue join ticket (guardian signature)
#### `POST /circles/:id/join_ticket`
Auth: session_token
Preconditions:
- verified_in_group=true
- accepted_rules=true
- wallet_verified=true
- circle.status == Recruiting
- circle.contract_address is known

Ticket signing message:
`MC_JOIN|contract_address|wallet|exp|nonce`
Return: { wallet, exp, nonce, sig }

Store `join_tickets` (used=false).
Errors:
- NOT_VERIFIED_IN_GROUP
- RULES_NOT_ACCEPTED
- WALLET_NOT_VERIFIED
- CONTRACT_NOT_READY
- CIRCLE_NOT_RECRUITING

### 4.7 Attach contract (leader-only)
#### `POST /circles/:id/attach_contract`
Auth: session_token
Body: { circle_id, contract_address }
Steps:
- verify caller is circle leader and in group
- verify contract code hash + get_config() match DB snapshot
- store circles.contract_address (idempotent)
Return: { ok, contract_address }

### 4.8 Deposit intent (optional, UX helper)
#### `POST /circles/:id/deposit_intent`
Auth: session_token
Body: { circle_id, purpose: "collateral"|"prefund", amount_usdt }
Return: { jetton_wallet, tx_value_nano, payload_base64 }
Safety gates:
- require circle.onchain_jetton_wallet is set (INIT done), otherwise reject (prevents silent loss)
- require member.join_status == onchain_joined (non-members are ignored by contract)
- require amount_usdt >= min_deposit_units

### 4.9 Tx notify (optional, UX improvement)
#### `POST /tx/notify`
Auth: session_token
Body: { tx_hash, circle_id }
Steps:
- fetch tx from provider
- validate tx references circle contract
- insert chain_events (processed=false)
Return: ack

This endpoint is optional because indexer should detect tx anyway.

### 4.10 Read circle status (mirrored)
#### `GET /circles/:id/status`
Return:
- circle status + onchain timestamps + funded progress (from mirror)
- member balances (redacted where needed)

---

## 5) Contract deployment pipeline (backend-assisted)
MVP choices:
- A) deploy manually with scripts + paste contract_address into DB
- B) backend endpoint `POST /circles/:id/deploy` that runs deployment with deployer key (more automation, more risk)

Recommended:
- deploy via scripts
- then call `POST /circles/:id/attach_contract` to save contract_address + jetton_master

IMPORTANT:
- once contract attached, backend should validate:
  - contract code hash matches expected
  - get_config() returns same N/C/interval/bps
If mismatch -> refuse attach.

---

## 6) Indexer (event sync) — design
Goal:
- UI must reflect on-chain state within 15–30s
- fully idempotent
- provider fallback

### 6.1 Strategy (most robust)
Rather than decoding every log format, do:
1) Poll tx list for contract (TonAPI / Toncenter)
2) For any new tx:
   - store chain_events
3) After processing tx batch, call contract get methods:
   - get_status()
   - get_members()
   - get_member(wallet) for each wallet (N<=12)
Then update DB mirrors based on get results.

This avoids fragile log decoding.

### 6.2 Minimal indexer loop (pseudo)
For each circle where status in (Recruiting, Locked, Active, EmergencyStop, Terminated):
- fetch latest transactions since last_lt
- insert chain_events (idempotency_key = contract:lt:tx_hash or contract:lt:event_type)
- after new tx exist:
  - call get_status() -> update circles timestamps/status
  - call get_members() -> ensure member list in DB
  - for each wallet: get_member(wallet) -> update balances + has_won

Mark processed=true.

### 6.3 Idempotency
- chain_events.idempotency_key must be unique
- processing must be safe to rerun:
  - upsert mirrors using current on-chain values, not "increment deltas"

### 6.4 Handling provider outages
- if TonAPI fails 3 times -> switch to Toncenter
- exponential backoff
- alert if lag > 5 minutes

---

## 7) Scheduled jobs (cron) — minimal & safe
Because contract enforces time gates, backend cron is only for UX reminders.

### 7.1 notify_scheduler (every minute)
- read circles with status Active/Locked
- compare now to onchain_due_at, grace_end_at, commit_end_at, reveal_end_at
- enqueue notifications_queue with dedupe_key to avoid duplicates:
  - due_T-24h, due_T-2h, due_now, grace_half, grace_end
  - commit_end reminders (T-10m, T-2m)
  - reveal_end reminders (T-10m, T-2m)

### 7.2 bot_sender (every 10s)
- send group messages / DM
- on 429: backoff + do not spam
- for "Progress" messages, prefer edit rather than send

---

## 8) Bot Integration points (backend-side)
Backend should provide helper functions:
- `postOrEditProgressMessage(circle_id)`
- `postAuctionOpen(circle_id, cycle_index)`
- `postSettlement(circle_id, cycle_index, summary)`
- `postDefault(circle_id, defaulters)`
- `postEmergency(circle_id, reason)`

Bot message templates must be deterministic and non-harassing.

---

## 9) UX-critical backend behaviors
### 9.1 Withdraw UX
Contract supports withdraw modes:
- mode=1 payout only (Active)
- mode=2 withdraw all (Completed/Terminated/EmergencyStop)
- mode=3 recruiting exit

Backend must:
- show correct CTA based on contract status + member withdrawable
- never claim user can withdraw buckets that contract forbids in Active

### 9.2 Recruiting exit UX
Backend should show "Exit & withdraw deposits" if:
- circle.status == Recruiting
- member is on-chain joined
- member has collateral/prefund > 0

---

# END PART 2 — BACKEND (SUPPORT)
Next: Bot & Mini App (UI) – Telegram bot commands, Mini App screens, TonConnect integration, and safe UX mapping to contract withdraw modes.

---

# PART 3 — BOT & MINI APP (UI)

## 1) Telegram Bot

### 1.1 Commands
- `/start` — basic intro
- `/circle` — list circles for this group
- `/status [circle_id]` — show status + on-chain timestamps
- `/help` — command list

### 1.2 Message Types
- **JoinPost**: initial "Join this circle" message (pin if possible)
- **Progress**: deposit/funding progress (use edit, not new message)
- **Auction**: commit open, reveal reminder
- **Settlement**: cycle result, winner, credits
- **Default**: termination notice
- **Emergency**: emergency stop notice

### 1.3 Template Rules (English)
- Always show on-chain timestamps
- Use neutral language (no shaming)
- Be concise

### 1.4 Anti-spam Rules
- Join Post: send once; pin if possible
- Deposit progress: EDIT existing message every ~30 minutes or when milestone changes
- Reminders:
  - due: T-24h, T-2h, due_now, grace_half, grace_end
  - reveal: max 2 tags per user per cycle
- If Telegram returns 429:
  - exponential backoff
  - drop non-critical reminders first

---

## 2) Mini App (React) — Screens & Flows (English Copy)

### 2.1 Routes
- `/` Home (Group Landing)
- `/circle/:circle_id` Circle Dashboard
- `/circle/:circle_id/join` Join Flow
- `/circle/:circle_id/auction` Auction Flow (Commit/Reveal)
- `/circle/:circle_id/withdraw` Withdraw Screen

Tech:
- React + Vite + TS
- shadcn/ui
- TonConnect UI
- Telegram WebApp SDK (initData + theme + close)

---

## 3) Global UI Copy Rules (English)
1) Always show on-chain timestamps (due_at, grace_end_at, commit_end_at, reveal_end_at).
2) While status is `Active`:
   - Only allow withdrawing **Withdrawable Now** (mode=1), if `withdrawable > 0`.
   - Do NOT allow withdrawing collateral, prefund, credit, future_locked, or vesting during Active.
3) While status is `Recruiting`:
   - If user has deposits: show **Exit & Refund** (mode=3).
4) When status is `Terminated / Completed / EmergencyStop`:
   - Show **Withdraw All** (mode=2).
5) Auction explanation must always be present and short:
   - never say "interest rate"
   - always say "How much do you want to receive?"

---

## 4) Screen-by-screen Specification (English)

### S0 — Group Landing
Title: `MoneyCircle`
Sections:
- `Active Circles` (Open)
- `Recruiting Circles` (Join)
- `Past Circles` (Withdraw if needed)
Buttons:
- `Create Circle` (backend validates permissions)
On load:
- call `/auth/telegram` with initData
- fetch circles list for this group

---

### S1 — Create Circle
Title: `Create a Circle`
Form:
- `Circle Name` (optional)
- `Members (N)` (2–12)
- `Contribution per Cycle (USDT)`
- `Interval` (Weekly / Monthly)
Read-only info:
- `Discount cap: 5%`
- `Grace period: 24h`
- `Collateral: 7% / 10% / 12%`
- `Fees: 1% (winner pays)`
- `Safety lock: enabled for Cycle 1`
CTA:
- `Create Circle`
Error copy:
- `This circle exceeds the current cap. Please reduce N or contribution.`

---

### S2 — Circle Dashboard (Core)
Header:
- Circle name + status badge
Status badges:
- `Recruiting`, `Locked`, `Active`, `Terminated`, `Completed`, `Emergency Stop`

Section: `On-chain Schedule`
- `Due time` (due_at)
- `Grace ends` (grace_end_at)
- If auction open:
  - `Commit ends` (commit_end_at)
  - `Reveal ends` (reveal_end_at)

Section: `Your Balances (On-chain)`
- `Collateral`
- `Prefund`
- `Credit`
- `Vesting Locked`
- `Locked for Future Payments`
- `Withdrawable Now`

CTA logic:
- If `status == Recruiting`:
  - If not joined: `Join Circle`
  - If joined & has deposits: `Exit & Refund` (mode=3)
- If `status == Active`:
  - If `withdrawable > 0`: `Withdraw Now` (mode=1)
  - If phase commit/reveal: `Go to Auction`
- If `status in {Terminated, Completed, EmergencyStop}`:
  - `Withdraw All` (mode=2)

---

### S3 — Join Flow: Rules Summary
Title: `Join Circle`
Show:
- Key rules (N, C, interval)
- `15-second explanation` box:

**15-second explanation (fixed copy):**
> In each cycle, one member receives the pot.  
> You place a blind bid by entering **"How much do you want to receive?"**  
> The person willing to receive the least wins the cycle.  
> The difference becomes credits for other members (reduces their next payment).

Checkbox:
- `I understand and accept the rules.`
Button:
- `Continue`

---

### S4 — Wallet Verification (TonConnect Proof)
Title: `Verify Wallet Ownership`
Step 1: `Connect Wallet` (TonConnect)
Step 2: `Sign to Verify` (challenge/response)
Success:
- `Verified ✅`
Error:
- `Verification failed. Please retry.`

---

### S5 — Join Ticket
Title: `Join Ticket`
Show:
- `Ticket expires in: {mm:ss}`
CTA:
- `Submit Join On-chain`
Secondary:
- `Back to Dashboard`

---

### S6 — On-chain Join Confirmation
Title: `Joining On-chain`
Show:
- tx hash
- `Waiting for confirmation…`
CTA:
- `Refresh Status`

---

### S7 — Deposits
Title: `Deposit Collateral & Prefund`
Sections:
- `Required Collateral: {X} USDT`
- `Recommended Prefund: ≥ {C} USDT`
Buttons:
- `Deposit Collateral`
- `Deposit Prefund`
Notes:
- `Make sure you have enough TON for network fees.`
- `Your deposit is recorded via smart contract notifications.`

---

### S8 — Auction: Commit
Title: `Blind Auction — Commit`
Show:
- `Commit ends in: {mm:ss}`
Input:
- `How much do you want to receive? (USDT)`
Min/Max:
- `Minimum: {minPayout}`
- `Maximum: {pot}`
15-second explanation box (same copy)
CTA:
- `Commit Bid`
On success:
- `Bid committed. Don't forget to reveal.`

---

### S9 — Auction: Reveal
Title: `Blind Auction — Reveal`
Show:
- `Reveal ends in: {mm:ss}`
CTA:
- `Reveal Bid`
On success:
- `Revealed. Please wait for results.`

---

### S10 — Result & Payout
Title: `Cycle Result`
Show:
- Winner, pot, fee, credits
If user is winner:
- `Withdrawable Now: {withdrawable}`
- Button: `Withdraw Now` (mode=1)
- `Vesting Locked: {vesting_locked}`
- `Locked for Future Payments: {future_locked}`
Copy:
> Withdrawable Now can be withdrawn immediately.  
> Vesting and Future Lock cannot be withdrawn while the circle is active.

---

### S11 — Withdraw (Mode-based)
Title: `Withdraw`
Detect:
- status + mode availability
Mode=1 (Active):
- Label: `Withdrawable Now`
- Button: `Withdraw Now`
Mode=2 (Completed/Terminated/EmergencyStop):
- Label: `Withdraw All`
- Button: `Withdraw All`
Mode=3 (Recruiting):
- Label: `Exit & Refund`
- Button: `Exit & Refund`

Confirmation modal copy (important):
- Active: `This will withdraw only your Withdrawable Now amount. Other funds remain locked by rules.`
- Recruiting: `This will exit the circle and refund your deposits. You will no longer be a participant.`
- Terminated/Completed: `This will withdraw all remaining balances.`

---

## 5) TonConnect Implementation Notes
- Always require wallet connected before sending any tx.
- Store (payoutWanted, salt) in localStorage for reveal.
- If localStorage missing (user cleared data):
  - show: `You need your saved bid data to reveal. Please contact support if you lost it.` (MVP reality)
  - (Optional P1) store encrypted salt server-side, but that adds custody-like responsibility.

---

## 6) UX Improvements (English)
### 6.1 Reduce fear: "funds safety banner"
On every Circle screen:
> Funds are held by a smart contract. The app cannot move your funds outside the rules.

### 6.2 Winner clarity (avoid disputes)
Always show 3 lines:
- Withdrawable Now
- Vesting Locked
- Locked for Future Payments

### 6.3 No harassment defaults
Use neutral reminders:
- "Payment is due"
- "Grace period is ending"
Avoid:
- "debtor", "shame", "punishment"

---

# END PART 3 — BOT & MINI APP (UI)
All UI language is English. Contract/Backend remain language-neutral.
