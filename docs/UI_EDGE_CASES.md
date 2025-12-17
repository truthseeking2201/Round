# MoneyCircle — Mini App UI/UX Edge Case Checklist (MVP v1.2.1)

Source of truth:
- Execution + gates: `MASTER_PLAN.md`
- Implementation guide: `docs/BUILD_GUIDE.md`
- UI spec (screens/copy): `docs/UI_SPEC.md`

Goal of this checklist:
- Ensure the Mini App never misleads users about **what can be withdrawn**.
- Ensure common failure modes (Telegram context, wallet mismatch, indexer lag) have clear UX.
- Provide a single “did we cover it?” list for QA.

---

## A) Global edge cases (all screens)

### A1) Telegram context missing
- Condition: WebApp `initData` missing (opened outside Telegram).
- UX: show error + “Retry”; allow dev override only when `VITE_DEV_INIT_DATA` is set.

### A2) Session expired / invalid
- Condition: backend returns `AUTH_REQUIRED` / `AUTH_INVALID`.
- UX: show “Session expired” and ask user to reopen the Mini App (or Retry).

### A3) Indexer lag / stale mirror
- Condition: `circle.last_indexed_at` is old (≥ 5 minutes) or `last_indexer_error` exists.
- UX: show a warning banner:
  - “Data may be outdated; wait 15–60s and Refresh after sending a tx.”
  - Never block money-safe actions solely due to lag (user can still submit tx).

### A4) Wrong wallet connected
- Condition: TonConnect wallet != member’s bound wallet.
- UX: block money actions (deposit / withdraw / commit / reveal / join submit) with `WALLET_MISMATCH`.

---

## B) Screen-by-screen edge cases

### S0 — Group Landing
- TG opened outside group → backend returns `TG_GROUP_REQUIRED` → show “Open in a group”.
- List loads but empty → show “No circles”.

### S1 — Create Circle
- Bot not present in group → `BOT_NOT_IN_GROUP` → show “Add bot to group”.
- Caller not in group → `TG_NOT_IN_GROUP` / `TG_BANNED`.
- Cap exceeded → `CAP_EXCEEDED`.
- Leader rate limit → `LEADER_RATE_LIMIT`.

### S2 — Circle Dashboard
**State → CTA mapping (must not drift):**
- `Recruiting`
  - If not on-chain joined → show “Join Circle”.
  - If on-chain joined AND has deposits → show “Exit & Refund” (withdraw mode=3).
- `Locked`
  - Show deposits + liveness actions, but no withdraw CTA.
- `Active`
  - If `withdrawable > 0` → show “Withdraw Now” (withdraw mode=1).
  - If auction window open → show “Go to Auction”.
- `Completed | Terminated | EmergencyStop`
  - Show “Withdraw All” (withdraw mode=2).

**Liveness buttons (critical for “backend dead” scenarios):**
- “Run Debit” during funding window.
- “Finalize Auction” after `reveal_end_at`.
- “Terminate Default” after `grace_end_at` when not funded.

### S3 — Rules
- Must show 15-second explanation and avoid “interest rate” language.
- Must block “Continue” until checkbox checked.

### S4 — Wallet Verification
- Wallet not connected → `WALLET_NOT_CONNECTED`.
- TonConnect `signData` unsupported/fails → show “Verification failed” with retry.
- Wallet already bound → `WALLET_ALREADY_BOUND`.
- Expired challenge → `WALLET_BIND_EXPIRED`.

### S5 — Join Ticket
- Contract not attached → `CONTRACT_NOT_READY`.
- Ticket expiry countdown; if expired, offer “Get a new ticket”.

### S6 — On-chain Join Confirmation
Known limitation (MVP):
- TonConnect does not always provide tx hash; Mini App cannot reliably track confirmation without provider-side lookup.
- UX: after send, instruct “wait and refresh”.

### S7 — Deposits (Collateral / Prefund)
- Contract Jetton wallet not initialized (TEP-89) → `JETTON_WALLET_NOT_INITIALIZED`:
  - Must show “Init Jetton Wallet (required once)” CTA.
- Not on-chain member → `NOT_ONCHAIN_MEMBER` (prevent silent loss; contract ignores non-member deposits).
- Deposit too small (< `min_deposit_units`) → `DEPOSIT_TOO_SMALL` (prevent silent ignore).

### S8 — Auction: Commit
- Window closed (commit_end passed) → contract rejects; UX should show “Commit window closed”.
- User already won (`has_won=true`) → must block commit.
- Bid out of bounds → `BID_OUT_OF_BOUNDS`.

### S9 — Auction: Reveal
- Missing bid data (localStorage cleared / different device) → `MISSING_BID_DATA` with explicit explanation.
- Window closed (reveal_end passed) → contract rejects; UX should show “Reveal window closed”.

### S10 — Result
- Winner clarity must always show:
  - Withdrawable Now
  - Vesting Locked
  - Locked for Future Payments
- Must state: only Withdrawable Now can be withdrawn while Active.

### S11 — Withdraw
- `Active` → only mode=1 allowed and only when `withdrawable>0`.
- `Recruiting` → mode=3 shown only when on-chain joined AND has deposits.
- `Completed/Terminated/EmergencyStop` → mode=2 allowed.
- If contract Jetton wallet not initialized → show Init CTA (withdraw will revert otherwise).

---

## C) Known MVP limitations (explicitly accepted)
- No reliable tx confirmation tracking in-app (without provider-side lookup).
- Commit/reveal on one device then reveal on another device fails (localStorage salt missing).
- UI does not display “already committed / already revealed” status (contract doesn’t expose it via current get methods).

