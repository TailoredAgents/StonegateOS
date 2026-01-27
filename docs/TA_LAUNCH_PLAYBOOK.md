# TA Launch Playbook (New Company Deployment)

This is the step-by-step checklist Tailored Agents follows to launch StonegateOS for a new company using **configuration-only** changes.

Assumption: **one deployment per company** (separate Render services + separate DB).

## 0) Inputs you must collect
- Company name + logo + brand colors
- Primary phone (Twilio number) and support email
- Business hours + timezone
- Service area (cities/zip rules) + "out of area" behavior
- Pricing tiers + discount % + special fees (e.g., mattress fee)
- Review link (Google)
- Sales routing (default assignee) + team members
- AI voice: agent name + tone + any "must say / must not say"
- Integrations:
  - Twilio creds + webhook URLs configured
  - Meta (optional): page/app creds + webhook verify token
  - Google Ads (optional): customerId/loginCustomerId + creds

## 1) Create a new deployment (Render)
1. Create new services:
   - `site` (public site + `/team`)
   - `api` (backend + admin routes)
   - `outbox-worker` (background jobs)
2. Create a new Postgres database for the company.
3. Copy env vars from Stonegate as a baseline, then change:
   - Company-specific env vars (URLs, any per-company IDs)
   - Integration secrets (Twilio/Meta/Google) if the company uses their own accounts

## 2) Set domains (website)
1. Point the company domain to the `site` service (CNAME/A record per Render instructions).
2. Ensure TLS/SSL is active.
3. Confirm these URLs resolve:
   - `https://{domain}/`
   - `https://{domain}/book`
   - `https://{domain}/team`

## 3) Run migrations
From Render shell (or your CI step):
```bash
cd /opt/render/project/src
npx -y pnpm@9.15.9 -w db:migrate
```

Verify DB health:
```bash
curl -sS -H "x-admin-api-key: $ADMIN_API_KEY" https://{api-domain}/api/admin/db/status
```

## 4) Company Pack (planned; config-only onboarding)
The repo includes the schema and inventory docs for a future "Company Pack" import/export flow, but the UI import/export is not treated as complete yet.

Current approach (today):
1. Set required env vars in Render (see `.env.example` and `DEPLOY-ON-RENDER.md`).
2. Configure operational settings in `/team` (lead routing, automations, templates) where applicable.

Planned approach (Phase 1 in `docs/TA_PLATFORM_PLAN.md`):
- Owner-only export/import of a Company Pack JSON via `/team`, validated against `docs/company-pack.schema.json`.

## 5) Configure integrations (per-company)

### Twilio (required if SMS/calls are used)
- Confirm the phone number's webhooks are set to your `api` endpoints (voice + sms + status).
- Send a test SMS in and verify it appears in Unified Inbox.
- Place a test inbound call and confirm it routes correctly.

### Meta (optional)
- Verify webhook endpoint and subscribed fields.
- Send a test message to the page and confirm it ingests into Unified Inbox.

### Google Ads (optional)
- Set creds in `api` and `outbox-worker`.
- In `/team` -> **Marketing** -> **Google Ads**, click **Sync now** and confirm health is green.

## 6) Create team users + roles
1. Create users for Sales/Ops/Owner roles.
2. Confirm each role sees only what they should.
3. Confirm "Assigned to" default matches Company Pack settings.

## 7) QA checklist (must pass before go-live)

**Public site**
- Call button and SMS button use the correct business number.
- `/book` flow completes and creates appointment + confirmation messages.
- Performance: pages load normally on mobile.

**CRM**
- Create contact manually (with missing address allowed).
- Create appointment (and reschedule/cancel).
- Unified inbox:
  - inbound SMS appears
  - inbound DM appears (if enabled)
  - attachments view opens
- Sales HQ:
  - new lead appears
  - call escalation works during business hours
  - follow-up queue behavior matches current policy

**Ops + Owner**
- Job completion updates revenue.
- Commissions/payout calculations are visible.

## 8) Go-live
- Switch ads/campaigns to the new domain/phone if needed.
- Enable any automations only after verifying:
  - correct identity/voice
  - correct service area behavior
  - correct escalation rules

## 9) Support runbook (first 7 days)
- Daily: check provider health (Twilio/Meta/Google) + error logs.
- Daily: verify inbound leads appear and routing works.
- Weekly: export key data snapshots (DB backups or exports) before major changes.
