# MoneyCircle Mini App (React + Vite + TS)

Source of truth:
- UI spec: `docs/UI_SPEC.md`
- Full build guide: `docs/BUILD_GUIDE.md`

## Routes (MVP)
- `/` Group Landing
- `/create` Create Circle (helper route)
- `/circle/:circleId` Circle Dashboard
- `/circle/:circleId/join` Join Flow (rules → wallet proof → join ticket → on-chain join)
- `/circle/:circleId/auction` Auction Flow (commit/reveal)
- `/circle/:circleId/withdraw` Withdraw (mode-based)

## Environment variables
Create `miniapp/.env`:
- `VITE_FUNCTIONS_BASE_URL` (Supabase Edge Functions base URL, e.g. `https://<project>.functions.supabase.co/functions/v1`)
- `VITE_TONCONNECT_MANIFEST_URL` (TonConnect manifest URL)

Optional (local dev only):
- `VITE_DEV_INIT_DATA` (Telegram initData string for local testing)

## Run
```bash
cd miniapp
npm install
npm run dev
```

## Notes
- Wallet proof uses TonConnect `signData` (type=`text`) and sends the result to backend `/wallet/bind_confirm`.
- Auction commit stores `{ payout, salt }` in `localStorage` (required for reveal), per `docs/UI_SPEC.md`.
- Deposits use `/circles/:id/deposit_intent` (backend builds the Jetton transfer payload) and require `Init Jetton Wallet` first (contract-side TEP-89).
