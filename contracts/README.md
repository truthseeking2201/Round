# MoneyCircle — CircleContract (v1.2.1 Hardened)

Source of truth:
- Execution plan: `MASTER_PLAN.md`
- Implementation guide: `docs/BUILD_GUIDE.md`
- Contract spec (critical fix pack): `docs/CONTRACT_SPEC.md`
- Attack test pack: `docs/SECURITY_TESTS.md`

## Local build & tests
- Build: `npm run build`
- Tests: `npm test`

## Contract overview
- Model: **1 Circle = 1 Contract**
- Asset: USDT Jetton (amounts stored in smallest units; typically 6 decimals)
- Key safety properties:
  - On-chain time gates (`due_at <= now < grace_end_at`, commit/reveal windows)
  - Idempotent funding via `due_remaining`
  - Pull withdrawals (no batch push)
  - Anti-spoof deposits (accept only `transfer_notification` from the contract’s `jetton_wallet`)
  - EmergencyStop freezes ops except withdrawals

## Important runtime notes
### Jetton wallet discovery (TEP-89)
Deposits are processed only after `jetton_wallet` is set.
- After deploy, call `INIT` (`opcode=0xA001`) to request `take_wallet_address` from the allowlisted `jetton_master`.
- Verify `get_jetton_wallet()` returns a non-null address before allowing deposits in the UI.

### Withdraw modes (opcode `0x6001`)
- `mode=1` payout-only: allowed in `Active/Completed/Terminated/EmergencyStop`, drains only `withdrawable`.
- `mode=2` all: allowed in `Completed/Terminated/EmergencyStop`, drains all buckets.
- `mode=3` recruiting exit: allowed only in `Recruiting`, removes member (swap-with-last) and refunds deposits.

Withdraw calls must attach enough TON for gas (see `MIN_WITHDRAW_GAS` in `contracts/CircleContract.tact`).

## Test-only components
`contracts/JettonWalletMock.tact` is a sandbox helper used by `tests/` to simulate:
- `transfer_notification` deposits
- successful transfers via `excesses`
- bounced transfers (to validate outbox restore)
