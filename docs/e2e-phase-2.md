# E2E Testing Program – Phase 2 Environment & Data Foundations

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


This phase implements the hermetic environment required by our Playwright suite: deterministic env files, dockerized dependencies (MailHog, LocalStack, Twilio mock), a reusable seeding CLI, and a convenience script that boots the API, site, and worker together with prefixed logs.

## 1. Local Dependency Stack (`devops/docker-compose.yml`)
- Added MailHog for SMTP capture (`localhost:1025` / UI on `http://localhost:8025`).
- Added LocalStack (default services: S3/SQS/EventBridge) with persistent `localstack-data` volume for future object/queue tests.
- Added a Twilio mock container (built from `devops/twilio-mock/`) that intercepts `POST /2010-04-01/Accounts/:sid/Messages.json`, logs SMS payloads, and exposes a lightweight API for reading/clearing messages (`GET|DELETE /messages`). The API layer now honors `TWILIO_API_BASE_URL`, so Playwright can point real SMS flows at the mock service without code changes elsewhere.

## 2. Deterministic Env Management
- Committed `.env.e2e` with placeholder secrets for every integration (DB, Stripe test keys, Twilio mock, MailHog, LocalStack). This file is copied to `.env` on demand to eliminate drift.
- Added `apps/api/.env.e2e.local` and `apps/site/.env.e2e.local` so each Next.js app reads the same deterministic values; `scripts/sync-e2e-env.ts` copies these into `.env.local` via `pnpm e2e:env`.
- `.gitignore` now explicitly allows the tracked `*.env.e2e*` files so future contributors don’t accidentally delete them.

## 3. Database Seeding CLI (`scripts/seed-e2e.ts`)
- Drizzle-powered script truncates all major tables (contacts/properties/leads/quotes/appointments/outbox/payments) to guarantee isolation.
- Inserts a canonical contact/property/lead plus a pending quote and requested appointment derived from the pricing engine’s defaults. The script emits a structured JSON summary and inserts an `outboxEvents` breadcrumb for observability.
- Exposed via `pnpm seed:e2e`; meant to run inside Playwright `globalSetup` and locally before manual verification.

## 4. Dev Entry Point (`pnpm -w dev:e2e`)
- Script flow: `pnpm e2e:env` → `docker compose -f devops/docker-compose.yml up -d` → `pnpm seed:e2e` → `concurrently` starts site, API, and the outbox worker with prefixed logs (`[site]`, `[api]`, `[worker]`).
- Ensures everyone boots the exact same services before running Playwright or manual QA; complements upcoming `pnpm test:e2e`.

## 5. Supporting Updates
- README now documents the new env sync/seed/dev commands.
- `.env.example` includes `TWILIO_API_BASE_URL` so production/staging can opt into mock hosts if needed.
- `apps/api/src/lib/notifications.ts` resolves Twilio requests against `TWILIO_API_BASE_URL`, defaulting to `https://api.twilio.com`.
- Added `concurrently` dev dependency and generated an up-to-date pnpm lockfile.

### Next Steps (Phase 3 Preview)
1. Scaffold `tests/e2e/` structure with Playwright config + helper utilities using the environment hooks built here.
2. Wire Playwright global setup to call `pnpm seed:e2e`, wait for `dev:e2e` health checks, and preload auth storage states.
3. Begin coding the first journeys (Lead Intake + Quote lifecycle) against the hermetic stack.
