# E2E Testing Program – Phase 4 Cross-Cutting Capabilities

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 4 adds the shared infrastructure needed for reliable journeys: deterministic auth helpers, data-tagging + cleanup, notification capture, and worker orchestration hooks. These improvements keep the suite hermetic while making failures highly diagnosable.

## 1. Auth Helper Stack
- `/admin/login` now fronts all admin routes. A new middleware (`apps/site/src/middleware.ts`) checks for the `myst-admin-session` cookie and redirects anonymous users to the login screen. Entering the `ADMIN_API_KEY` (1Password) stores an HTTP-only cookie so the UI can reload boards without resubmitting the key each time.
- `POST /api/admin/session` mirrors the login behavior programmatically. Playwright’s global setup hits this endpoint with the admin key to capture a valid storage state in `tests/e2e/storage/admin.json`, enabling admin-specific specs to boot instantly without stepping through the UI.
- `tests/e2e/support/auth.ts` exposes `bootstrapVisitorStorage` (blank state) and `bootstrapAdminStorage` (session bootstrap) so suites can opt into the right persona with a single helper call.

## 2. Data Tagging & Cleanup
- Every seed or factory-generated record now embeds the `E2E_RUN_ID` tag (configurable via `.env.e2e`). Utilities in `tests/e2e/support/run-context.ts` + `data-factories.ts` guarantee lead emails look like `e2e+lead-{runId}@StonegateOS.test`.
- `scripts/seed-e2e.ts` writes tagged contacts/leads/quotes/appointments so tests, DB dumps, and analytics can tie rows back to a specific run.
- `scripts/cleanup-e2e.ts` (wired via `pnpm cleanup:e2e`) purges tagged contacts and any matching outbox events. This protects shared dev DBs if a test aborts mid-run.

## 3. Notification Capture & Worker Orchestration
- Playwright helpers for MailHog and the Twilio mock (`tests/e2e/support/mailhog.ts`, `twilio.ts`) now include polling utilities so tests can `await waitForMailhogMessage()` / `waitForTwilioMessage()` and assert notification content without manual sleeps.
- The outbox dispatch helper (`tests/e2e/support/outbox.ts`) wraps `POST /api/admin/outbox/dispatch`, allowing suites to flush background jobs deterministically between steps.

## 4. Developer Experience Updates
- README documents the new admin login flow and the `pnpm cleanup:e2e` command.
- `.env.example` / `.env.e2e` gained `E2E_RUN_ID` so engineers (and CI) can namespace runs explicitly when needed.
- Playwright global setup now seeds the DB, waits for both health checks, bootstraps visitor + admin storage states, and leaves diagnostics in `tests/e2e/storage/*` ready for downstream specs.

### What’s Next
1. Layer the Phase 5 core journeys on top of these helpers (lead intake, quote lifecycle, billing) using the notification + worker utilities for assertions.
2. Expand data factories to produce quotes/leads dynamically through the public API to mimic real traffic.
3. Start emitting per-test diagnostics (Playwright `test.step` logs, DB snapshots) outlined for Phase 6 to catch flakes early.
