# Release Checklist (Production Safety)

Use this checklist for changes that affect live operations (Stonegate or any TA deployment).

## Scope
This checklist applies to:
- `apps/site` (public site + `/team`)
- `apps/api` (API + admin routes)
- `outbox-worker` (background jobs)

## Before you merge / deploy
1. Confirm the intent
   - What user-facing behavior should change?
   - What is the rollback plan (revert commit vs config toggle)?

2. Validate locally (or in a dev/staging deployment)
   - `pnpm -w build`
   - If you changed DB schema: `pnpm -w db:migrate`
   - If tests exist for your area: `pnpm -w test:e2e` (or at least the relevant spec)

3. Config/Secrets sanity
   - Any new env vars added? Ensure they’re set in Render for **site + api + worker** as needed.
   - If URLs changed: confirm `API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SITE_URL`, `SITE_URL`.
   - Confirm provider health is expected (Twilio/Meta/Google Ads/etc.).

4. Deployment safety
   - Prefer small, reversible deploys.
   - For high-risk changes, schedule outside peak hours.

## After deploy (must verify)
Run a quick smoke check (recommended):
- `pnpm -w smoke` (requires env vars; see `scripts/smoke.ts`)

### Running smoke checks on Render (recommended)
You can run smoke checks directly from the Render shell for the **API** service (best default) because Render provides `RENDER_EXTERNAL_URL` automatically.

From the Render shell:
```bash
cd /opt/render/project/src
npx -y pnpm@9.15.9 -w smoke
```

Required env vars in the service:
- `ADMIN_API_KEY`
- Either `API_BASE_URL` (recommended) or Render's `RENDER_EXTERNAL_URL` (automatic)

Optional:
- `NEXT_PUBLIC_SITE_URL` or `SITE_URL` so the script checks `site.healthz` too.

Manual verification (minimum):
1. Site health
   - `GET https://{api}/api/healthz` returns OK
   - `GET https://{site}/api/healthz` returns OK

2. CRM fundamentals
   - Create a contact
   - Open Unified Inbox threads list
   - Send one outbound SMS (if configured) to a test number

3. Booking fundamentals
   - Complete `/book` flow and confirm appointment created
   - Confirm confirmation notifications are correct (book/reschedule/cancel)

4. Sales fundamentals
   - New lead appears in Sales HQ queue
   - Call escalation connects correctly (press 1 connect)

5. Worker fundamentals
   - Worker is running and draining `outbox_events`
   - Any background agent you rely on (SEO, marketing sync) is not erroring

## Rollback plan
If production breaks:
1. Roll back to the previous good Render deploy (fastest)
2. Capture the error:
   - service logs (site/api/worker)
   - request id + time window
3. If DB migrations were applied:
   - Prefer forward-fix migrations (avoid manual DB edits)
