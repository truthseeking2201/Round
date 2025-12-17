# MoneyCircle Telegram Bot (MVP)

Source of truth:
- `docs/BUILD_GUIDE.md` (Part 3 — Bot)

## Environment variables
- `TELEGRAM_BOT_TOKEN` (required)
- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required)

Optional:
- `POLL_INTERVAL_MS` (default `1000`)

## Run locally
```bash
cd bot
npm install
npm run dev
```

## Commands
- `/start` — basic intro
- `/help` — command list
- `/circle` — list circles for this group
- `/status [circle_id]` — show status + on-chain timestamps

Notes:
- This bot intentionally avoids @mentions (anti-harassment default).
- Scheduled reminders are sent by backend cron (`backend/functions/notify-scheduler` + `backend/functions/bot-sender`).
