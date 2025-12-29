# Stonegate API App

This is the Next.js API application that powers StonegateOS. It exposes REST-style endpoints under `/api` and hosts business logic for leads, appointments, quotes, notifications, payments, and calendar sync.

## Key Responsibilities
- Lead intake and appointment scheduling (`/api/web/lead-intake`, `/api/appointments`, `/api/web/appointments/...`).
- Quote lifecycle (`/api/quotes`, `/api/quotes/:id/send`, public `/api/public/quotes/:token`).
- Notifications + outbox processing (`apps/api/src/lib/notifications.ts`, `apps/api/src/lib/outbox-processor.ts`).
- Stripe and Plaid ingestion (`/api/payments`, `/api/admin/stripe/backfill`, Plaid admin routes).
- Calendar sync and webhook processing (`/api/calendar/status`, `/api/calendar/webhook`).

## Local Development
From the repo root:
```bash
pnpm --filter api dev
```

The API runs at `http://localhost:3001` by default.

## Environment Variables
Required:
- `DATABASE_URL`
- `ADMIN_API_KEY`

Common optional integrations:
- `OPENAI_API_KEY`, `OPENAI_MODEL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `DM_WEBHOOK_URL`, `DM_WEBHOOK_TOKEN`, `DM_WEBHOOK_FROM`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_WEBHOOK_URL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `QUOTE_ALERT_EMAIL`

## Migrations
Run from the repo root:
```bash
pnpm -w db:migrate
```

## Notes
The API app is part of a monorepo. See the root `README.md` for full setup and environment guidance.
