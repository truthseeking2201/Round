# MoneyCircle — Attack Test Pack (v1.2.1)

Execution plan (scope + gates): `MASTER_PLAN.md`  
Implementation guide: `docs/BUILD_GUIDE.md`

Goal: run before testnet/mainnet to catch "correct process but wrong result" bugs (stuck funds, double charge, spoof deposit, penalty escape, drift from window edge).

General pass criteria (all tests):
- No path allows `pot_pool > pot`.
- No path allows `due_remaining[m] < 0`.
- Idempotent: calling 100 times does not create double debit / double settle / double penalty.
- No "orphan" tokens: all remainders must go to `treasury_owed` (or equivalent policy).

---

## A) Funding & Debit (logic kill)
1) **Double debit spam**: call `TRIGGER_DEBIT_ALL` 100 times within window → each member is deducted at most `C` (via `due_remaining`).
2) **Tiny deposit multiple times**: deposit `0.001 USDT` x 200 times (>= min_deposit_units if set) → total prefund/collateral correct; debit still correct; no overflow.
3) **Topup during grace**: insufficient prefund before `due_at`, add more during grace → auto-debit-on-deposit runs; no double charge.
4) **Debit outside window**: call before `due_at` or at/after `grace_end_at` → reject.
5) **Late penalty spam**: trigger debit multiple times when funded during grace → late penalty applied only once (`late_penalty_applied`).
6) **Order of funds**: verify deduction order `credit -> future_locked -> prefund` is correct, no negatives.
7) **Collateral auto-heal (fix #3)**: collateral short by 0.01 due to penalty, prefund sufficient → `_debitOne` auto-heals collateral from prefund/credit before gate; member still funded.

---

## B) Terminate & Default
8) **Terminate before grace**: try calling `TERMINATE_DEFAULT` when `now < grace_end_at` → reject.
9) **DefaultEligible sync**: at `now == grace_end_at` phase must transition to `DefaultEligible` (half-open windows).
10) **Terminate correct**: after `grace_end_at`, still underfunded → terminate succeeds; status = `Terminated`.
11) **Refund paid_this_cycle**: `paid_this_cycle[m]` returns to `prefund[m]` correctly; `pot_pool=0`.
12) **Seize cap**: collateral < collateral_required → slash = min(collateral, collateral_required); no negatives.
13) **Seize escape buckets (fix #2)**: defaulter gets seized `future_locked`, `credit`, `vesting_unreleased`, `withdrawable` (if policy enabled).
14) **Vesting reset safety**: after terminate, no case where `vesting_locked - vesting_released < 0`.
15) **Penalty distribution deterministic**: recipients = `!is_defaulter`; `rem` goes to `treasury_owed` (no orphan).
16) **Divide-by-zero guard**: if `rc==0` then `treasury_owed += penalty_pool` and no revert.
17) **Withdraw after terminate**: each user withdraws correct remaining balance; no double withdraw (bucket reset before transfer/outbox).

---

## C) Auction commit/reveal
18) **Commit after commit_end** → reject.
19) **Reveal after reveal_end** → reject.
20) **Reveal wrong salt / hash mismatch** → reject.
21) **Reveal out-of-bounds**: payoutWanted < minPayout or > pot → reject.
22) **Non-reveal penalty once**: commit but don't reveal → finalize treats payoutWanted=pot + penalty only once.
23) **No-bid fallback rotation**: no one reveals valid bid → fallback winner rotation; payoutGross=pot.
24) **Tie-break deterministic**: same payoutWanted → lower commit_order wins; if still tie → address asc.
25) **has_won enforcement**: cycle 1 winner cannot commit in later cycles.
26) **Fallback avoids has_won (fix #4)**: no-bid fallback does not select someone with `has_won=true` (linear probe).

---

## D) Deposit spoofing (Jetton)
27) **Fake transfer_notification from sender != jetton_wallet** → ignore/reject; no state credit.
28) **Deposit from non-member** → ignore (no refund; no storage bloat).
29) **Malformed payload**: payload missing/different magic → default to policy purpose (recommended: PREFUND), contract does not crash.
30) **amount=0** → reject/ignore (per policy).

---

## E) Tickets & replay
31) **Ticket expire** → reject.
32) **Ticket replay** (same nonce) → reject.
33) **Ticket domain mismatch** (different contract address) → reject.
34) **EmergencyStop nonce replay** → reject.

---

## F) Safety lock & default profitability
35) **Cycle 1 settlement math**: fee + vesting + safetyLock + immediate correct; `immediate -> withdrawable`.
36) **Winner withdraw in Active (fix #1)**: `WITHDRAW(mode=1)` withdraws exactly `withdrawable` when `status=Active`.
37) **Attacker default after early win**: simulate default → total seized/locked >= benefit; attacker does not net-profit.
38) **future_locked auto-debit**: next cycle, `future_locked` is deducted before `prefund`, correctly reduces obligation.

---

## G) Rounding & dust
39) **Discount remainder**: `discount%(N-1)` does not become "orphan"; goes to `treasury_owed`.
40) **Penalty remainder**: same, `rem` goes to `treasury_owed`.
41) **Final withdraw no dust block**: no "stuck 0.000001" blocking final withdraw.

---

## H) Recruiting exit (fix #5)
42) **Recruiting exit no-deposit**: member exits without depositing → membership cancels ok; no wrong balance changes.
43) **Recruiting exit with deposits**: member exits → withdraws correct `collateral+prefund`, buckets reset to 0.
44) **Join/exit churn**: join-exit multiple times does not corrupt `members_count`/`member_list`.
45) **Cannot exit after Locked**: after lock → `mode=3` rejects.

---

## I) EmergencyStop enforcement
46) **EmergencyStop blocks ops**: after stop, all ops except `WITHDRAW`/`WITHDRAW_TREASURY`/`EMERGENCY_STOP` reject.
47) **Withdraw in EmergencyStop**: `WITHDRAW(mode=2)` withdraws all correctly; no double withdraw.
