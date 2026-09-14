# Release Checklist (Production Safety)

Use this checklist for changes that affect live operations (Stonegate or any TA deployment).

## Scope

This checklist applies to:

- `apps/site` (public site + `/team` + `/partners`)
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
   - If URLs changed: confirm `API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SITE_URL`, `SITE_URL`, and the exact Twilio Console callback origin in `TWILIO_WEBHOOK_PUBLIC_BASE_URL`.
   - Confirm provider health is expected (Twilio/Meta/Google Ads/etc.).

4. Deployment safety
   - Prefer small, reversible deploys.
   - For high-risk changes, schedule outside peak hours.

### Required Partner Portal release gate

For changes to portal access, page data, company tools, requests, uploads or worker behavior:

1. Pass the [Partner Portal production journey workflow](../.github/workflows/partner-portal-release.yml). It runs API/Site regressions, browser recovery, worker rendering, real PostgreSQL integration, production builds, and the [new-company journey](../scripts/test-partner-empty-company.mts) against actual local services. The journey must cover activation, every tab, first location, a request awaiting staff review and optional company tools. Record skips and failures; mocked page success and process health alone are insufficient.
2. Review [render.yaml](../render.yaml) and the effective deployed API **and worker** settings. Explicitly configure reads/writes, purpose authentication, routine magic login, internal test mode and account restrictions; verify required secrets without printing their values. Apply migrations through the existing runner. Check quote signing secrets and the actual trusted-proxy hop configuration when readiness reports an issue.
3. Match the approved company behavior through normal staff settings. Basic location creation must work independently of portfolio tools. For the [September 13 LandL release](audits/partner-landl-portal-remediation-2026-09-13.md), enable its six company tools, retain staff confirmation for every request, and keep card, ACH and hosted payment collection disabled. Do not enable outbound notifications as part of this release.
4. After deployment, run the read-only [portal release check](../scripts/check-partner-portal-release.mts): `pnpm check:partner-portal:release`. Supply `PARTNER_PORTAL_CHECK_API_URL`, `PARTNER_PORTAL_CHECK_ACCOUNT_ID` and `PARTNER_PORTAL_CHECK_SESSION` through the environment; use a normal signed-in session and never put credentials in command arguments or logs. `--readiness-only` checks infrastructure without a session, but does not satisfy the account gate. Confirm the expected company and ordinary browser sign-in separately.
5. Open every relevant tab on the deployed Site and verify truthful empty states, reads, permitted actions, retry behavior and support references. Confirm upload storage/CORS and the deployed worker when those paths changed. Use controlled test accounts for record-creating journeys; keep real company data intact. Record deployment revision, service versions, checks and any remaining limits in the release audit.

A deliberately configured maintenance or read-only state must be shown clearly to partners. It does not satisfy the normal-service portal gate, even when the general health check is green. Keep payment and notification enablement as separate, explicitly approved changes.

The API pre-deploy command must run `scripts/check-partner-portal-deployment.mts` after the existing migration check. It reads configuration and database state, rejects missing settings, and permits explicitly configured maintenance.

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
