# StonegateOS Monorepo

## Prerequisites
- Node.js 18+
- pnpm 9+
- Docker Desktop (for local Postgres)

## Environment
1. Copy `.env.example` to `.env` and fill in values.
2. Set `DATABASE_URL` to your local connection string, for example `postgres://stonegate:stonegate@localhost:5432/stonegate`.
3. When running the API locally, set `NEXT_PUBLIC_API_BASE_URL` (site) and `API_BASE_URL` (server actions) to `http://localhost:3001`.
4. Provide `ADMIN_API_KEY`; this key gates the appointments API and the `/admin/estimates` board.
5. Adjust `APPOINTMENT_TIMEZONE` (defaults to `America/New_York`) if the crew operates in a different locale.

## Database
1. Start Postgres via Docker:
   ```bash
   docker compose -f devops/docker-compose.yml up -d postgres
   ```
2. Apply the latest schema:
   ```bash
   pnpm -w db:migrate
   ```
   This creates/updates the `contacts`, `properties`, `leads`, and new `quotes` tables with pricing breakdown fields.
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

## Calendar Sync
- Configure the Google Calendar credentials in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`) and point `GOOGLE_CALENDAR_WEBHOOK_URL` at your deployed API (`https://your-api.example.com/api/calendar/webhook`).
- The API registers a watch channel and persists metadata in the new `calendar_sync_state` table; fetch `/api/calendar/status` with your `ADMIN_API_KEY` to inspect last sync, webhook activity, and watch expiry.
- The Team Console header now surfaces a Calendar Sync badge summarizing health (last sync, webhook freshness, upcoming renewals).
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
- Debug a single headed Chromium run:
  ```bash
  pnpm test:e2e:headed
  ```
- Current coverage (Phase 5): lead intake funnel and quote lifecycle acceptance flows (`tests/e2e/specs/lead-intake.spec.ts`, `tests/e2e/specs/quote-lifecycle.spec.ts`).
- `pnpm dev:e2e` writes service logs to `artifacts/e2e/logs/{site,api,worker}.log`. Playwright attaches the tail of each file on failure, so keep the dev stack running to capture diagnostics.
- Tests probe Site/API/MailHog/Twilio health before execution. If any dependency is missing you’ll see an explicit skip message (`Missing dependencies: …`) instead of a timeout.
- Use `pnpm report:e2e` after a run to summarize pass/fail/flake counts from `artifacts/e2e/json-report.json`; this feeds into monthly flake/latency reviews.

## Useful Commands
```bash
pnpm -w build    # production build for all apps
pnpm -w lint     # lint all workspaces
pnpm -w test     # run workspace tests (if configured)
pnpm outbox:worker  # run the outbox dispatcher (see docs/outbox-worker.md)
```

## Content
Markdown/MDX content lives under `apps/site/content`. Re-run `pnpm -w build` after changes to regenerate static pages.

### Junk Removal Service Catalog
The site now ships with a junk removal catalog (replacing pressure washing):
- Single Item Pickup (`apps/site/content/services/single-item.mdx`)
- Furniture Removal (`apps/site/content/services/furniture.mdx`)
- Appliance Removal (`apps/site/content/services/appliances.mdx`)
- Yard Waste & Debris (`apps/site/content/services/yard-waste.mdx`)
- Construction Debris (`apps/site/content/services/construction-debris.mdx`)
- Hot Tub Removal (`apps/site/content/services/hot-tub.mdx`)

Hero images point at placeholder assets under `apps/site/public/images/services/`.
Replace them with real photos (same filenames) whenever you’re ready.

### Brand & Copy Configuration (TODOs)
Update these when details are final:
- Company name/metadata: `apps/site/src/app/layout.tsx`, `apps/site/src/lib/metadata.ts`
- Homepage and marketing pages: `apps/site/content/pages/*.mdx`
- Contact info (phone/email): `apps/site/src/components/Footer.tsx`, `apps/site/content/pages/contact.mdx`
- Domain and canonical URL: `NEXT_PUBLIC_SITE_URL` in env and `apps/site/src/lib/metadata.ts`
- Chat prompts: `apps/site/src/app/api/chat/route.ts`, team prompts `apps/api/app/api/chat/route.ts`
- Notification prompts: `apps/api/src/lib/ai.ts`, `apps/api/src/lib/notifications.ts`
- Logo: swap `/images/brand/Myst_logo.png` with Stonegate logo and update alt text if filename changes.

Placeholders currently in use:
- Email: `austin@stonegatejunkremoval.com`
- Phone: `(404) 445-3408`
- Domain: `https://stonegatejunkremoval.com`
Replace in content/components once finalized.

## Deployment
Render deployment details are tracked in `DEPLOY-ON-RENDER.md` along with the generated `render.yaml` blueprint.

If deploying Stonegate-branded site/API, ensure:
- `NEXT_PUBLIC_SITE_URL` reflects the public domain (e.g., `https://stonegatejunkremoval.com`).
- `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` are set for site/server actions.
- `ADMIN_API_KEY` is configured for admin routes and server actions.

## Notifications
- Estimate requests currently log email/SMS payloads via `notifyEstimateRequested` (see `apps/api/src/lib/notifications.ts`).
- Twilio SMS is wired: if `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` are set, the server will attempt to send a confirmation SMS in addition to logging.
- For email, replace the logger with your provider integration (e.g., Gmail/SMTP) when credentials are ready.
- Outbox events are drained by a lightweight worker. See `docs/outbox-worker.md` for deployment instructions.

## Payments & Stripe
- Backfill charges with `pnpm tsx scripts/stripe-backfill.ts` (or the admin backfill endpoint).
- Charges tagged with `appointment_id` metadata in Stripe will auto-attach to the matching appointment.
- Review and reconcile charges under `/admin/payments`; the dashboard highlights unmatched counts.

## Quotes
- Create quotes via the Owner Hub Admin API (`POST /api/quotes`) using services and add-ons priced through the MystOS engine.
- Send quotes with shareable tokens (`POST /api/quotes/:id/send`) to generate customer-facing links (e.g., `/quote/{token}`) or manage them in the `/admin/quotes` board.
- Customers accept or decline through the public endpoint (`/quote/{token}`); decisions update the admin board in real time.
- Outbox events capture `quote.sent` and `quote.decision` for follow-up automations. Run `pnpm tsx scripts/quote-demo.ts` to create a demo quote, enqueue outbox events, and exercise the worker flow end-to-end.
- Internal alerts (set `QUOTE_ALERT_EMAIL`) notify your ops/owner inbox whenever a quote is sent or a customer responds.

### Environment for Chat & Notifications
- Chat API (in `apps/site`) reads `OPENAI_API_KEY` and optional `OPENAI_MODEL` (defaults to `gpt-5-mini`).
- For SMS/email provider wiring, add:
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
  - Your email SMTP creds as needed

You can place these in the monorepo root `.env` or per-app `.env.local` files. Both API and Site load `.env.local`, `.env`, and the monorepo root `.env` at startup.

### Dev commands
- API: `pnpm --filter api dev`
- Site: `pnpm --filter site dev`
- Admin dashboards: visit `/admin/login` and enter the `ADMIN_API_KEY` (stored in 1Password). Successful login drops a session cookie so you can navigate `/admin/*` routes; run `pnpm cleanup:e2e` to purge related test data.

