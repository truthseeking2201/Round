# MoneyCircle — Mini App UI Specification (English)

Execution plan (scope + gates): `MASTER_PLAN.md`

This file is **UI-only**. Source of truth remains `docs/BUILD_GUIDE.md` (Part 3 — BOT & MINI APP (UI)).

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
