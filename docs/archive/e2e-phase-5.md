# E2E Testing Program – Phase 5 Core Journey Coverage

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 5 brings the first two must-have journeys to Playwright: lead intake (site funnel) and the quote lifecycle (admin issue → customer decision). Both scenarios exercise UI + API + background workers with zero mocks.

## 1. Lead Intake Journey (`tests/e2e/specs/lead-intake.spec.ts`)
- Drives the public lead form end-to-end: selects multiple services, fills property/contact/scheduling details, consents to updates, and submits the request.
- Asserts customer-facing confirmation UI (“You’re on our in-person schedule!”) renders with the expected success copy.
- Queries Postgres via `tests/e2e/support/db.ts` to ensure the lead, contact, appointment, and outbox records exist with the correct services and tags.
- Uses the new notification helpers to verify MailHog and Twilio capture the confirmation email + SMS; `drainOutbox` forces the worker to flush before assertions.

## 2. Quote Lifecycle Journey (`tests/e2e/specs/quote-lifecycle.spec.ts`)
- Seeds a contact/property through the real `POST /api/web/lead-intake` endpoint, then uses the admin API to create + send a quote (reflecting actual ops flow).
- Navigates the public share link, clicks “Accept quote”, and confirms the UI updates (status pill flips to “Accepted” and decision form disappears).
- Validates quote state + outbox rows directly in Postgres and ensures both `quote.sent` and `quote.decision` notifications fire via MailHog/Twilio.

## 3. Shared Tooling Enhancements
- `tests/e2e/support/db.ts` centralizes Drizzle access for leads/quotes/outbox lookups, enabling tests to assert DB side effects without reimplementing SQL.
- `tests/e2e/support/wait.ts` provides a lightweight polling helper for DB conditions, complementing the existing MailHog/Twilio waiters.
- Existing helpers (`drainOutbox`, `clearMailhog`, `clearTwilioMessages`) are now part of each journey to keep runs hermetic.

## 4. Developer Notes
- Run `pnpm -w dev:e2e` (to start Postgres, MailHog, Twilio mock, LocalStack, API, Site, and the worker) before `pnpm test:e2e` so notifications + background jobs work.
- Use `pnpm cleanup:e2e` if a run aborts mid-way; all tagged lead/quote/outbox rows are safe to purge thanks to `E2E_RUN_ID` tagging.
- Both specs rely on SMTP + Twilio mocks configured in `.env.e2e`. If either service is offline, the tests will wait until timeout; ensure Docker compose is healthy first.

### Next Targets
1. Extend coverage to billing/Stripe test mode and admin boards (appointments/payments) once the local Stripe CLI flow is scripted.
2. Add per-test log/trace attachments (Phase 6) and green/amber flake tracking to stabilize CI gating.
