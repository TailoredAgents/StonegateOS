# StonegateOS Monorepo

StonegateOS is a monorepo for a local service business: a customer-facing website + booking flow, plus an internal CRM ("Team Console") for sales/ops/owners.

## Apps
- `apps/site`: public marketing site + `/book` + Team Console UI at `/team`.
- `apps/api`: backend + admin API (Next.js) with Drizzle/Postgres.
- `apps/app`: optional owner dashboard app (WIP/experimental).

## Major Features (Current)
- Team Console (`/team`): Unified Inbox (SMS/Messenger/email), Contacts, Pipeline (drag-and-drop), Calendar (day/week/month), Sales HQ + call coaching, Outbound queue, Partners, Owner HQ, Marketing dashboards (Google Ads + Website Analytics), SEO agent, Control/settings.
- Outbox worker: drains `outbox_events` and runs scheduled jobs (reminders, SEO autopublish, marketing sync, call analysis/coaching).
- Integrations: Twilio (SMS + calls), Meta (Lead Ads + Messenger), Google Ads (sync + analyst), optional Google Calendar sync.

## Prerequisites
- Node.js 22.20.0 for local development (see `.nvmrc`). Render is pinned to Node 20 in `render.yaml`.
- pnpm 9.15.9 (see root `package.json`).
- Docker Desktop (for local Postgres).

## Environment
1. Copy `.env.example` to `.env` and fill in values.
2. Set `DATABASE_URL` to your local connection string, for example `postgres://stonegate:stonegate@localhost:5432/stonegate`.
3. Set `NEXT_PUBLIC_SITE_URL` (site) and `NEXT_PUBLIC_API_BASE_URL` (site) plus `API_BASE_URL` (server actions and API calls) to match your local ports (`http://localhost:3000` and `http://localhost:3001`).
4. Provide `ADMIN_API_KEY`; this gates admin routes and the team console server actions.
5. Timezone defaults to Eastern (`America/New_York`) with automatic DST; no env is needed unless you intentionally override `APPOINTMENT_TIMEZONE`.
6. Team Console authentication supports both:
   - Team member accounts (magic link + optional password) - preferred for accountability.
   - Temporary legacy "break-glass" sessions (Owner/Crew keys, see `apps/site/src/lib/crew-session.ts`) - kept during active development and removed later.

## Database
1. Start Postgres via Docker:
   ```bash
   docker compose -f devops/docker-compose.yml up -d postgres
   ```
2. Apply the latest schema:
   ```bash
   pnpm -w db:migrate
   ```
3. Stop the database when you are done:
   ```bash
   docker compose -f devops/docker-compose.yml down
   ```

## Development
- Install dependencies:
  ```bash
  pnpm install
  ```
- Run both apps (API + Site):
  ```bash
  pnpm -w dev
  ```
  The API listens on `http://localhost:3001` (via `apps/api`). The site runs on `http://localhost:3000`.
- Run the Owner Hub separately if needed:
  ```bash
  pnpm --filter app dev
  ```

## Calendar Sync
- Configure Google Calendar credentials in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`) and point `GOOGLE_CALENDAR_WEBHOOK_URL` at your deployed API (`https://your-api.example.com/api/calendar/webhook`).
- The API registers a watch channel and persists metadata in the `calendar_sync_state` table. Fetch `/api/calendar/status` with your `ADMIN_API_KEY` to inspect last sync, webhook activity, and watch expiry.
- The Team Console exposes a Calendar Sync badge in the Settings tab.
- Optional: set `GOOGLE_CALENDAR_SYNC_LOOKBACK_DAYS` to adjust how far back the sync job replays events when the token is reset (defaults to 45 days).

## E2E Environment
- Sync deterministic env files:
  ```bash
  pnpm e2e:env
  ```
- Seed the database baseline used by Playwright/globalSetup:
  ```bash
  pnpm seed:e2e
  ```
- Start the full hermetic stack (Docker: Postgres, MailHog, LocalStack, Twilio mock + site/api/worker):
  ```bash
  pnpm -w dev:e2e
  ```
- Reset artifacts between runs:
  ```bash
  pnpm cleanup:e2e
  ```
- Run the Playwright suite:
  ```bash
  pnpm test:e2e
  ```
- Current coverage includes lead intake, quote lifecycle, and smoke checks:
  - `tests/e2e/specs/lead-intake.spec.ts`
  - `tests/e2e/specs/quote-lifecycle.spec.ts`
  - `tests/e2e/specs/smoke.spec.ts`
- `pnpm dev:e2e` writes service logs to `artifacts/e2e/logs/{site,api,worker}.log`. Playwright attaches the tail of each file on failure.

## Useful Commands
```bash
pnpm -w build       # production build for all apps
pnpm -w lint        # lint all workspaces
pnpm -w test        # run workspace tests (if configured)
pnpm outbox:worker  # run the outbox dispatcher (see docs/outbox-worker.md)
pnpm -w smoke       # quick production-smoke checks (see docs/RELEASE_CHECKLIST.md)
pnpm --filter api dev
pnpm --filter site dev
pnpm --filter app dev
```

## Content
Markdown/MDX content lives under `apps/site/content`. Re-run `pnpm -w build` after changes to regenerate static pages.

### Junk Removal Service Catalog
The site ships with a junk removal catalog:
- Rubbish (common household waste) (`apps/site/content/services/single-item.mdx`)
- Furniture Removal (`apps/site/content/services/furniture.mdx`)
- Appliance Removal (`apps/site/content/services/appliances.mdx`)
- Yard Waste & Debris (`apps/site/content/services/yard-waste.mdx`)
- Construction Debris (`apps/site/content/services/construction-debris.mdx`)
- Hot Tub Removal (`apps/site/content/services/hot-tub.mdx`)

Hero images point at placeholder assets under `apps/site/public/images/services/`. Replace them with real photos (same filenames) when ready.

### Brand & Copy Configuration (Build-Time, SEO-safe)
The marketing site reads public branding from env at build time (no runtime DB fetch on public pages).

- Set `NEXT_PUBLIC_COMPANY_*` vars in `.env` / Render to change company name, phone, email, logo, and structured data.
- See `apps/site/src/lib/company.ts` and `.env.example`.

Note: This repo’s marketing site is a starter template. For other businesses, it’s expected you’ll customize or replace the marketing site (BYO site) while keeping the CRM + automations as the reusable product.

Placeholders currently in use:
- Email: `austin@stonegatejunkremoval.com`
- Phone: `(404) 777-2631`
- Domain: `https://stonegatejunkremoval.com`

## Deployment
Render deployment details are tracked in `DEPLOY-ON-RENDER.md` along with the generated `render.yaml` blueprint.

If deploying Stonegate-branded site/API, ensure:
- `NEXT_PUBLIC_SITE_URL` reflects the public domain (e.g., `https://stonegatejunkremoval.com`).
- `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` are set for site/server actions.
- `ADMIN_API_KEY` is configured for admin routes and server actions.

## Notifications
- Estimate confirmations and reminders are sent via `sendEstimateConfirmation` and related helpers in `apps/api/src/lib/notifications.ts`.
- Twilio SMS and SMTP email are used when credentials exist. Missing credentials log structured notifications instead of failing.
- Outbox events are drained by a lightweight worker. See `docs/outbox-worker.md` for deployment instructions.

## Payments & Stripe
- Backfill charges with `pnpm tsx scripts/stripe-backfill.ts` or the admin backfill endpoint.
- Charges tagged with `appointment_id` metadata in Stripe will auto-attach to the matching appointment.
- Review and reconcile charges under the Team Console Payments tab (`/team?tab=payments`).

## Quotes
- Create quotes via the admin API (`POST /api/quotes`) using services and add-ons priced through the pricing engine.
- Send quotes with shareable tokens (`POST /api/quotes/:id/send`) to generate customer-facing links (e.g., `/quote/{token}`).
- Customers accept or decline through the public endpoint (`/quote/{token}`).
- Outbox events capture `quote.sent` and `quote.decision` for follow-up automations.
- Internal alerts (set `QUOTE_ALERT_EMAIL`) notify your ops/owner inbox whenever a quote is sent or a customer responds.

### Environment for Chat & Notifications
- Chat API (in `apps/site`) reads `OPENAI_API_KEY` and optional `OPENAI_MODEL` (defaults to `gpt-5-mini`).
- For SMS/email provider wiring, add:
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
  - SMTP credentials: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

You can place these in the monorepo root `.env` or per-app `.env.local` files. Both API and Site load `.env.local`, `.env`, and the monorepo root `.env` at startup.

### Team Console Access
- Visit `/admin/login` to set the admin session cookie, or go directly to `/team` and log in via the UI.
- The `/admin/*` routes are redirects into the Team Console tabs.

Team Console login options:
- Preferred: `/team/login` (request a magic link or log in with a password if set).
- Temporary: "Emergency access" sessions (Owner/Crew keys). These are intended as break-glass only while iterating and will be removed before the system is considered "finished" and sellable.

## Docs
Start here: `docs/README.md`.
