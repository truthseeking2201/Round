# MoneyCircle — Circle Contract Spec v1.2.1 (Critical Fix Pack)

Execution plan (scope + gates): `MASTER_PLAN.md`  
Implementation guide: `docs/BUILD_GUIDE.md`

Goal: patch "logic bombs" that could cause stuck funds or penalty escape in spec v1.2, while keeping MVP economics (max_discount, take_rate, vesting/safety-lock) and not expanding scope beyond what's necessary for **No-loss**.

Scope of changes (compared to v1.2):
- `WITHDRAW` (opcode `0x6001`): add `mode` to separate "withdraw payout while Active" / "withdraw all when ended" / "exit Recruiting".
- `TERMINATE_DEFAULT` (opcode `0x4001`): define defaulter/recipient correctly, seize additional "escapable" buckets, reset vesting to prevent negatives, handle `rc==0`.
- `_debitOne` (Funding): auto-heal collateral shortage from `prefund`/`credit` before collateral gate to prevent "death spiral".
- `FINALIZE_AUCTION` fallback winner: avoid selecting someone with `has_won=true` (linear probe).
- Additional guardrails: no orphan dust, EmergencyStop enforcement, half-open time gates to prevent overlap, withdraw destination anti-phishing.

---

## 1) Fix #1 — Liquidity Trap: Winner stuck with payout while circle is Active

### 1.1. Required change
In v1.2, settlement writes payout to `member.withdrawable` but `WITHDRAW` only allows in `{Completed, Terminated, EmergencyStop}` ⇒ Winner cannot withdraw while `status=Active`.

✅ v1.2.1 allows **payout-only** withdrawal immediately when `status=Active` (and still allows in end states).

### 1.2. `WITHDRAW` (opcode `0x6001`) — add `mode:uint8`

Keep single opcode, add `mode` field:
- `mode = 1`: `WITHDRAW_PAYOUT_ONLY` — withdraw only `withdrawable`
- `mode = 2`: `WITHDRAW_ALL` — withdraw all buckets (only when ended)
- `mode = 3`: `RECRUITING_EXIT` — cancel participation + withdraw deposited funds (only in Recruiting)

#### Mode 1 — `WITHDRAW_PAYOUT_ONLY` (fix #1)
Pre:
- `status ∈ {Active, Completed, Terminated, EmergencyStop}`
- `member.exists == true`
- `member.withdrawable > 0`
Logic:
- `amount = member.withdrawable`
- `member.withdrawable = 0` (atomic before transfer/outbox)
- send Jetton `amount` to **`msg.sender`** (do not accept arbitrary destination).

In mode=1 **ABSOLUTELY DO NOT** add/withdraw these buckets:
`collateral`, `prefund`, `credit`, `future_locked`, `vesting_locked - vesting_released`.

#### Mode 2 — `WITHDRAW_ALL` (keep end behavior, but prevent negatives)
Pre:
- `status ∈ {Completed, Terminated, EmergencyStop}`
- `member.exists == true`
Compute:
- `vesting_unreleased = max(0, vesting_locked - vesting_released)`
- `amount = collateral + prefund + credit + withdrawable + future_locked + vesting_unreleased`
Post:
- set all above buckets to 0 (atomic before transfer/outbox)
- send Jetton `amount` to `msg.sender`.

#### Mode 3 — `RECRUITING_EXIT` (fix #5, see section 5)
Pre:
- `status == Recruiting`
- `member.exists == true` and `member.active == true`
Logic:
1) Cancel membership:
   - remove `msg.sender` from `member_list` (swap-with-last since `N ≤ 12`)
   - `members_count--`
   - `member.active = false`
2) Withdraw deposits:
   - `amount = member.collateral + member.prefund`
   - reset all buckets: `collateral=prefund=credit=withdrawable=future_locked=vesting_locked=vesting_released=0`
   - send Jetton `amount` to `msg.sender` (if `amount==0` just cancel).

---

## 2) Fix #2 — Defaulter Escape: defaulter can still withdraw Safety Lock/Vesting/Credit after Terminate

### 2.1. Root cause
In v1.2, `TERMINATE_DEFAULT` only slashes `collateral` and `WITHDRAW_ALL` adds `future_locked` (and possibly vesting/credit) ⇒ defaulter can "escape with safety lock".

### 2.2. Defaulter/recipient definition (required)
Not just based on `due_remaining==0` since collateral gate policy may change.

- `is_defaulter(m) = (cycle.due_remaining[m] > 0) OR (member.collateral < collateral_required)`
- `is_recipient(m) = NOT is_defaulter(m)`

### 2.3. Update `TERMINATE_DEFAULT` (opcode `0x4001`)

Pre (time gate + phase):
- `status ∈ {Locked, Active}` (depending on impl, but not in Recruiting/Completed/Terminated/EmergencyStop)
- `phase == DefaultEligible`
- `now >= grace_end_at`
- `funded_count < N`

Step 1) Refund current cycle:
- For each member `m`:
  - `refund = paid_this_cycle[m]`
  - `member[m].prefund += refund`
  - `paid_this_cycle[m] = 0`
- `pot_pool = 0`

Step 2) Slash/Seize defaulters:
For each `m` where `is_defaulter(m)=true`:
- `slash_collateral = min(member.collateral, collateral_required)` (policy cap by required collateral)
- `slash_future = member.future_locked`
- `slash_credit = member.credit`
- `slash_withdrawable = member.withdrawable` (recommended **YES** so defaulter doesn't keep payout "not yet withdrawn")
- `slash_vesting = max(0, member.vesting_locked - member.vesting_released)`

Update state (important to prevent negative ledger):
- `member.collateral -= slash_collateral`
- `member.future_locked = 0`
- `member.credit = 0`
- `member.withdrawable = 0`
- `member.vesting_locked = 0`
- `member.vesting_released = 0`

- `seize_amount = slash_collateral + slash_future + slash_credit + slash_withdrawable + slash_vesting`
- `penalty_pool += seize_amount`

Step 3) Distribute `penalty_pool` (fix divide-by-zero):
- `rc = count(is_recipient(m)==true)`
- If `rc == 0`:
  - `treasury_owed += penalty_pool` (or other policy, but required "no orphan")
  - `penalty_pool = 0`
- If `rc > 0`:
  - `per = penalty_pool / rc`
  - `rem = penalty_pool % rc`
  - For each recipient: `member.prefund += per`
  - `treasury_owed += rem` (no orphan dust)

Step 4) Final:
- `status = Terminated`

---

## 3) Fix #3 — Collateral Death Spiral: small collateral shortage → default despite sufficient prefund

### 3.1. Root cause
If `_debitOne` gates with `if collateral < collateral_required return`, while late/non-reveal penalty slightly reduces collateral, user could have **sufficient prefund** but still not be debited ⇒ wrongful default.

### 3.2. Update `_debitOne` (Funding) — auto-heal collateral before gate

Replace old gate with:

Auto-heal:
- `missing = collateral_required - member.collateral`
- if `missing > 0`:
  - `take = min(member.prefund, missing)` ⇒ `prefund -= take; collateral += take; missing -= take`
- if `missing > 0`:
  - `take = min(member.credit, missing)` ⇒ `credit -= take; collateral += take; missing -= take`

Gate:
- if `member.collateral < collateral_required` ⇒ return (still truly insufficient)

Then run idempotent debit in standard order:
`credit -> future_locked -> prefund` to reduce payment obligation.

---

## 4) Fix #4 — Rotation Collision: fallback winner can select someone with `has_won=true`

### 4.1. Update fallback winner selection in `FINALIZE_AUCTION`
Replace:
- `winner = member_list[(cycle_index-1) % N]`
With linear probe up to `N` steps:
- `start = (cycle_index - 1) % N`
- For `i in 0..N-1`:
  - `idx = (start + i) % N`
  - `cand = member_list[idx]`
  - if `members[cand].active && members[cand].has_won == false` ⇒ select `cand`, break
- If not found: revert `ALL_MEMBERS_ALREADY_WON` (guard against infinite loop; theoretically should not happen if `total_cycles == N` and each person wins at most once).

---

## 5) Fix #5 — Recruiting Deadlock: insufficient N means deposited funds stuck forever

### 5.1. Root cause
Allows deposit in `Recruiting` but no path to "cancel + withdraw".

### 5.2. `WITHDRAW(mode=3)` = `RECRUITING_EXIT`
Already defined in section 1.2.

Policy note:
- mode=3 is **exit + withdraw**, not "withdraw without canceling" to prevent ghost member causing wrong lock.

---

## 6) Appendix — Critical guardrails (recommended as mandatory)

### 6.1. Dust reserve must not be orphaned
Policy v1.2.1: all `rem` from division (discount/penalty) **must** be merged into `treasury_owed` (do not use separate `dust_reserve` if there's no clear withdrawal path).

### 6.2. EmergencyStop must be enforced in all functions
At the start of all entrypoints (except `WITHDRAW` and `EMERGENCY_STOP`):
- `require(status != EmergencyStop)`

Suggested policy:
- `WITHDRAW(mode=1|2)` still allowed when `status=EmergencyStop`.
- `TRIGGER_DEBIT_ALL`, `COMMIT_BID`, `REVEAL_BID`, `FINALIZE_AUCTION`, `TERMINATE_DEFAULT` **blocked** when `EmergencyStop`.

### 6.3. Time gates should use half-open to prevent overlap
To prevent "exactly at grace_end both debit and terminate are valid", standardize:
- Debit window: `due_at <= now < grace_end_at`
- DefaultEligible sync: `now >= grace_end_at`
- Terminate window: `now >= grace_end_at`
- Commit: `now < commit_end_at`
- Reveal: `now < reveal_end_at`
- Finalize: `now >= reveal_end_at`

### 6.4. Withdraw destination anti-phishing
Do not accept arbitrary "toJettonWallet/toAddress" from user in `WITHDRAW` (or if interface requires it, must `require(to == msg.sender)`).

### 6.5. Recipient set must use `!is_defaulter`
In terminate distribution, recipients = `NOT is_defaulter(m)` (not just `due_remaining==0`).
