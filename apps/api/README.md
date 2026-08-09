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
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_WEBHOOK_PUBLIC_BASE_URL`
  - The webhook base is the exact public API origin configured in Twilio. Production requires HTTPS; webhook validation never trusts Host or forwarded-host headers.
- `SMTP_HOST`, `SMTP_PORT`, optional paired `SMTP_USER` / `SMTP_PASS`,
  `SMTP_FROM`; optional `SMTP_SECURE` and bounded `SMTP_TIMEOUT_MS`
  - E2E/audit SMTP must be loopback-only and uses the metadata-only control
    plane at `EMAIL_FAKE_CONTROL_URL`; ordinary production rejects loopback.
    Testing a production build against loopback fakes requires both a nonempty
    `E2E_RUN_ID` and the exact `TEAM_CRM_AUDIT_MODE=1` sentinel.
- `DM_WEBHOOK_URL`, `DM_WEBHOOK_TOKEN`, `DM_WEBHOOK_FROM`
- `FB_VERIFY_TOKEN`, `FB_APP_SECRET`, `FB_PAGE_ID`, `FB_LEAD_FORM_IDS`
- `FB_PAGE_ACCESS_TOKEN` for a direct page token, or `FB_MESSENGER_ACCESS_TOKEN` / `FB_MARKETING_ACCESS_TOKEN` / `FB_LEADGEN_ACCESS_TOKEN` for a system/business token that can fetch a page token
- `META_DATASET_ID`, `META_CONVERSIONS_TOKEN`, `META_LEAD_EVENT_SOURCE`
- Local/CI Meta provider overrides: `FACEBOOK_GRAPH_API_BASE_URL`, `META_FAKE_CONTROL_URL` (real Graph is required in ordinary production; loopback is required in E2E/audit, including a dual-sentinel production-build audit)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_WEBHOOK_URL`
- Local/CI Calendar provider overrides: `GOOGLE_CALENDAR_API_BASE_URL`, `GOOGLE_CALENDAR_TOKEN_URL`, `GOOGLE_CALENDAR_FAKE_CONTROL_URL` (ordinary production rejects loopback; a dual-sentinel production-build audit requires it)
- `STRIPE_SECRET_KEY`
- `QUOTE_ALERT_EMAIL`
- `LEAD_ALERT_SMS`

## Migrations

Run from the repo root:

```bash
pnpm -w db:migrate
```

## Notes

The API app is part of a monorepo. See the root `README.md` for full setup and environment guidance.
For operations docs (Render, outbox worker, SEO agent, integrations), start at `docs/README.md`.
