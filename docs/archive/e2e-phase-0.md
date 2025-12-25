# E2E Testing Program – Phase 0 Discovery

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


This document satisfies the Phase 0 (“Discovery & Success Criteria”) deliverable for StonegateOS end-to-end (E2E) testing. It inventories the user journeys we must protect, enumerates technical preconditions, locks in non-functional requirements, and codifies ownership plus the definition of done for “E2E v1.”

## Critical Journeys & Preconditions

### 1. Lead Intake → Estimate Scheduling
- **Business outcome:** Every site visitor can submit the `/lead-intake` form, choose services/time windows, and receives SMS/email confirmation without manual intervention.
- **Systems touched:** `apps/site` (Next.js lead form + chatbot nudge), `apps/api` (`POST /api/web/lead-intake`), Postgres (`leads`, `contacts`, `properties`), outbox worker (`estimate.requested`), Twilio/SMTP integrations, GA4 Measurement Protocol hook.
- **Coverage intent:** Browser test drives form validation, scheduling picker, consent checkboxes, success UI, and polls API to confirm lead persistence plus outbox event generation.
- **Preconditions:** Dockerized Postgres running seeded fixture data, `.env` with `ADMIN_API_KEY`, Twilio + SMTP sandbox creds, GA4 test measurement IDs, worker process draining outbox or manual dispatch endpoint available.

### 2. Quote Lifecycle (Admin → Customer)
- **Business outcome:** Ops can create a quote in `/admin/quotes`, send it, customer opens `/quote/{token}`, accepts/declines, and boards update.
- **Systems touched:** `apps/site` admin board (Next.js), `apps/api` quote endpoints (`POST /api/quotes`, `/api/quotes/:id/send`, `/quote/{token}`), DB tables (`quotes`, `quote_line_items`, `outbox_events`), notifications, worker.
- **Coverage intent:** Playwright admin flow seeds services via API helper, asserts board state transitions, fetches share link, navigates customer view, completes decision, and verifies admin board + DB + outbox updates.
- **Preconditions:** Valid `ADMIN_API_KEY`, authenticated admin session strategy (UI login or server-side cookie bootstrap), worker running, Stripe test mode optional but should be mocked via stripe-cli webhook fixture when payment steps are added.

### 3. Operations Boards & Background Processing
- **Business outcome:** Admin kanban views (appointments, leads, quotes) reflect real-time pipeline after worker drains notifications and analytics outbox.
- **Systems touched:** Admin Next.js routes, API read models, Redis (future caching), background worker CLI, monitoring endpoints (e.g., `/api/admin/outbox/dispatch`).
- **Coverage intent:** Smoke tests ensure worker orchestration endpoints respond, poll for zero `outbox_events` backlog, and validate board filters/search.
- **Preconditions:** Worker process accessible (CLI or REST), health endpoints authenticated via `x-api-key`, deterministic seed data for board counts.

### 4. Payments / Stripe Test Mode
- **Business outcome:** Quotes that require deposits can charge via Stripe test cards, webhook handlers mutate lead/quote status, and admin payments tab reflects transactions.
- **Systems touched:** Stripe test account, local `stripe-cli` forwarding to `/api/stripe/webhook`, DB tables (`payments`, `appointments`), notification fan-out.
- **Coverage intent:** Once payment UI is gated, tests will drive checkout (hosted link or embedded), trigger stripe-cli webhook fixture, and assert DB + queue side effects.
- **Preconditions:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, stripe-cli installed in CI image, deterministic quote + customer fixture.

### Shared Technical Preconditions

| Dependency | Purpose | Notes for E2E |
| --- | --- | --- |
| `ADMIN_API_KEY` | Auth gate for admin boards + worker hooks | Store in `.env.e2e`; rotate via 1Password item `StonegateOS Admin Key`. |
| Postgres (Docker) | Primary datastore | `devops/docker-compose.yml` currently starts Postgres 16; Phase 2 will add Redis/MailHog. |
| Redis (planned) | Session/cache tier | Needed once background jobs rely on caching; include in compose expansion. |
| MailHog / SMTP sandbox | Capture customer emails | Add in compose + use HTTP API to fetch confirmation copy during tests. |
| Twilio sandbox | SMS verification | Use test credentials + magic numbers; disable outbound to production numbers. |
| Outbox worker | Notification + analytics dispatch | Run via `pnpm outbox:worker` or admin dispatch endpoint before assertions. |
| Stripe CLI | Webhook replay | Containerize for CI so we can deterministically replay events. |

## Non-Functional Requirements

- **Runtime budgets:** Target ≤12 minutes wall-clock for the full suite on CI runners (6 vCPU) with ≤3 minutes per journey locally. Suites failing the SLA must be split via Playwright projects or tags.
- **Flake tolerance:** ≤0.5% failure rate per 100 consecutive CI runs. Any test flaking twice in a 2-week window must be quarantined or fixed before merges proceed.
- **Execution environments:** 
  - CI: Headless Chromium + WebKit (mobile emulation optional) on Ubuntu via Playwright container images. 
  - Local: Headed Chromium by default with optional `PWDEBUG=1`; engineers run against Docker Compose stack using `.env.e2e.local`.
- **Secrets & config:** All environment configuration flows from `.env.e2e` committed to the repo with placeholder values plus `.env.e2e.local` (gitignored) for developer overrides. `pnpm e2e:env` (Phase 2) will sync .env files before each run.
- **Data determinism:** Dedicated schema (`StonegateOS_e2e`) or isolated tenant ID per run; seeding CLI resets + truncates via Drizzle. Every test creates namespaced records (`e2e+timestamp@StonegateOS.test`) for safe cleanup.
- **Artifacts & diagnostics:** Playwright trace/video retained on failure for 14 days, DB logs piped to artifacts, server stdout/stderr captured alongside test reports to accelerate triage.
- **CI resource usage:** Tests run after build/lint succeed; job caches PNPM store + Playwright browsers to keep cold-start <5 minutes.

## Ownership & Definition of Done

### Primary Owners (proposed – update once team confirms)

| Area | Owner | Responsibilities |
| --- | --- | --- |
| Site (apps/site) | Jeffrey Hacker – Product Eng | Lead selectors/utilities, customer journeys, MailHog/Twilio validation. |
| API (apps/api + workers) | Morgan Lee – Platform Eng | Seed CLI, admin auth helpers, webhook fixtures, DB health checks. |
| Infra / CI | Priya Desai – DevOps | Docker compose parity, GitHub Actions runtime, artifact storage, secret distribution. |
| QA / Test Strategy | Riley Chen – QA Lead | Playwright standards, test data policy, flake triage, nightly dashboard. |

> **Action:** Confirm/adjust owners with leadership before Phase 1 to guarantee staffing coverage.

### “E2E v1” Definition of Done

1. **Coverage:** Lead Intake → Estimate Scheduling and Quote Lifecycle journeys automated end-to-end with zero mocks, plus smoke check for outbox/worker health.
2. **Deterministic environment:** `pnpm -w dev:e2e` (Phase 2) launches API + Site + worker using `.env.e2e` with hermetic seed CLI invoked in Playwright `globalSetup`.
3. **Observability:** Each failure uploads Playwright trace/video, server logs, and DB snapshots as CI artifacts; docs link troubleshooting steps.
4. **Automation:** GitHub Actions workflow (`.github/workflows/e2e.yml`) blocks PR merges unless E2E + lint/unit succeed; nightly workflow exercises expanded matrix (desktop + mobile) against `main`.
5. **Reliability:** Suite meets runtime + flake targets defined above for four consecutive nightly runs before being marked “stable.”

### Open Questions / Follow-Ups
- Confirm whether Redis is mandatory for upcoming features; if yes, include in Docker Compose before Phase 2.
- Clarify if payments/Stripe scope is part of E2E v1 or Phase 5; affects seed data workload.
- Decide on secrets manager (1Password vs Doppler) for CI before writing `.env.e2e` sync scripts.
- Align on logging/observability storage (S3 vs GitHub artifacts) for Playwright videos to avoid retention surprises.

Once the actions above are resolved, Phase 1 (Architecture & Tooling Decisions) can begin.
