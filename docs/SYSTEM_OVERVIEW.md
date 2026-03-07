# StonegateOS — System Overview (Source of Truth)

This document maps what this repo is, what it runs in production, and where the major workflows live in code.

If you’re new here, also read:
- `StonegateOS/README.md` (repo overview + local dev)
- `StonegateOS/docs/CRITICAL_FLOWS.md` (flows that must never break)
- `StonegateOS/DEPLOY-ON-RENDER.md` (production deployment topology + env vars)
- Deep-dive pack for AI/system audits: `StonegateOS/docs/system/README.md`

---

## What This Project Is

StonegateOS is an “operating system” for a local service business:
- A **public marketing + booking site** (customers get an instant estimate, then book an appointment)
- An internal **CRM / Team Console** at `/team` (inbox, contacts, pipeline, calendar, ops, owner tools)
- Background automation via an **outbox worker** (notifications, reminders, analytics sync, AI drafting/automation)
- Optional **Discord agent (“Jarvis”)** as a worker that can read metrics and perform approval-gated actions

It is a **monorepo** intended to be deployed **one-company-per-deployment** (each company gets its own Render services + Postgres DB).

---

## Runtime Topology (Production)

Production is designed to run as multiple services (Render blueprint: `StonegateOS/render.yaml`):
- **Site web service** (`apps/site`): serves marketing pages + `/book*` flows + `/team` UI + some server routes/actions.
- **API web service** (`apps/api`): Next.js “API app” that owns DB access + business logic + webhooks.
- **Outbox worker** (root script): runs `StonegateOS/scripts/outbox-worker.ts` to drain `outbox_events` and run schedulers.
- **Discord agent worker** (optional): runs `StonegateOS/scripts/discord-agent-bot.ts`.
- **Postgres**: single DB backing the entire company instance.

---

## Repository Layout (Where Things Live)

### Apps
- Public site + Team Console UI: `StonegateOS/apps/site`
  - Marketing pages: `StonegateOS/apps/site/src/app/(site)`
    - `/book`: `StonegateOS/apps/site/src/app/(site)/book/page.tsx`
    - `/bookbrush`: `StonegateOS/apps/site/src/app/(site)/bookbrush/page.tsx`
    - `/bookdemo`: `StonegateOS/apps/site/src/app/(site)/bookdemo/page.tsx`
  - Core quote/booking UI component: `StonegateOS/apps/site/src/components/LeadForm.tsx`
  - Team Console: `StonegateOS/apps/site/src/app/team`
  - Site-side “agent/chat” API routes (used by the Team Console agent tab): `StonegateOS/apps/site/src/app/api/chat`

- Backend API (DB + logic + webhooks): `StonegateOS/apps/api`
  - App Router API routes:
    - Public/business endpoints: `StonegateOS/apps/api/app/api`
    - Admin endpoints (Team Console backend): `StonegateOS/apps/api/app/api/admin`
    - Partner portal endpoints: `StonegateOS/apps/api/app/api/portal`
    - Provider webhooks: `StonegateOS/apps/api/app/api/webhooks`
    - Public “no-auth” endpoints (uploads, web events, etc.): `StonegateOS/apps/api/app/api/public`
  - DB schema (Drizzle): `StonegateOS/apps/api/src/db/schema.ts`
  - Business logic modules: `StonegateOS/apps/api/src/lib`

### Workers (root scripts)
- Outbox worker entrypoint: `StonegateOS/scripts/outbox-worker.ts`
- Discord agent entrypoint: `StonegateOS/scripts/discord-agent-bot.ts`

---

## Core Domain Model (DB)

The “spine” tables (most features hang off these):
- `contacts`: people/orgs (customers, partners, callers)
- `properties`: addresses tied to a contact (job sites)
- `leads`: lead records for service requests
- `instant_quotes`: the instant estimate output from `/book*` flows
- `appointments`: scheduled jobs/estimates (calendar)
- `conversation_threads` / `conversation_messages`: unified inbox threads + messages (SMS/email/DM/calls)
- `outbox_events`: durable queue for async work (notifications, reminders, AI automation, analytics sync)

Partner portal tables:
- `partner_users`, `partner_sessions`, `partner_login_tokens`
- `partner_rate_cards`, `partner_rate_items`, `partner_bookings`

Marketing + analytics tables:
- `google_ads_*`, `meta_ads_insights_daily`
- `web_events`, `web_event_counts_daily`, `web_vitals`

Configuration tables:
- `policy_settings` (company policy JSON; used by pricing, hours, service area, templates, etc.)
- `automation_settings` (toggles and defaults)

Everything is defined in `StonegateOS/apps/api/src/db/schema.ts`.

---

## Configuration System (“Policy”)

Company-specific rules live in policy and env:
- Policy module: `StonegateOS/apps/api/src/lib/policy.ts`
- Stored in DB: `policy_settings` (JSON blobs per policy area)
- Some “build-time” branding lives in `NEXT_PUBLIC_COMPANY_*` env vars so the marketing site can stay fast and cacheable.

Examples of what policy controls:
- Service area rules (ZIP buckets, allowed/out-of-area decisions)
- Business hours and booking rules
- Templates for SMS/email messages
- Discount rules and pricing-related defaults

---

## Public Customer Flow: `/book` (Junk Removal)

This is the main “instant quote then book online” funnel.

### Step 1 — Quote request
UI entrypoint:
- `/book`: `StonegateOS/apps/site/src/app/(site)/book/page.tsx`
- Form/logic: `StonegateOS/apps/site/src/components/LeadForm.tsx` (default variant = junk)

Key calls from the browser:
1. Photo upload (optional):
   - `POST /api/public/junk-quote/uploads`
   - Handler: `StonegateOS/apps/api/app/api/public/junk-quote/uploads/route.ts`
2. Quote calculation + lead creation:
   - `POST /api/junk-quote`
   - Handler: `StonegateOS/apps/api/app/api/junk-quote/route.ts`
   - Uses pricing rules in:
      - `StonegateOS/apps/api/src/lib/junk-volume-pricing.ts`
   - Creates/updates:
      - `contacts`, `properties`, `leads`, `instant_quotes`, pipeline entries (`crm_pipeline`)
   - Enqueues outbox events (e.g., lead alerts / autopilot follow-ups):
     - inserted into `outbox_events` in the quote route(s)

Analytics:
- Client-side events are sent to `POST /api/public/web-events`
  - Handler: `StonegateOS/apps/api/app/api/public/web-events/route.ts`
- Google Ads / Meta pixel helpers are in:
  - `StonegateOS/apps/site/src/lib/google-ads.ts`
  - Meta pixel calls occur via `window.fbq` (if `NEXT_PUBLIC_META_PIXEL_ID` is configured)

### Step 2 — Availability, hold, booking
All `/book*` variants use the same booking endpoints (keyed by `instantQuoteId`):
1. Availability:
   - `POST /api/junk-quote/availability`
   - Handler: `StonegateOS/apps/api/app/api/junk-quote/availability/route.ts`
2. Slot hold (optional, to reduce race conditions):
   - `POST /api/junk-quote/hold`
   - Handler: `StonegateOS/apps/api/app/api/junk-quote/hold/route.ts`
3. Booking:
   - `POST /api/junk-quote/book`
   - Handler: `StonegateOS/apps/api/app/api/junk-quote/book/route.ts`

Booking writes:
- `appointments` (+ optional `appointment_holds`)
- Links appointment back to lead/contact/property
- Enqueues `outbox_events` for confirmations/alerts (e.g., “lead.alert”, estimate notifications)

Capacity / double-booking:
- Capacity logic comes from:
  - Policy + env (see `APPOINTMENT_CAPACITY` in `StonegateOS/.env.example`)
  - Helper: `StonegateOS/apps/api/src/lib/appointment-capacity.ts`

---

## Public Customer Flow: `/bookbrush` (Brush Clearing)

UI:
- `StonegateOS/apps/site/src/app/(site)/bookbrush/page.tsx` → `LeadForm variant="brush"`

APIs:
- Quote: `POST /api/brush-quote` (`StonegateOS/apps/api/app/api/brush-quote/route.ts`)
- Booking: still uses `POST /api/junk-quote/availability|hold|book` (the booking system is shared by `instantQuoteId`)

---

## Public Customer Flow: `/bookdemo` (Demolition)

UI:
- `StonegateOS/apps/site/src/app/(site)/bookdemo/page.tsx` → `LeadForm variant="demo"`

APIs:
- Quote: `POST /api/demo-quote` (`StonegateOS/apps/api/app/api/demo-quote/route.ts`)
- Booking: still uses `POST /api/junk-quote/availability|hold|book`

---

## Team Console (Internal CRM): `/team`

The Team Console is a single UI surface with multiple tabs (query-string routing), defined in:
- Tabs list + ids: `StonegateOS/README.md`
- UI entrypoint: `StonegateOS/apps/site/src/app/team`

The Team Console talks to admin endpoints on the API service:
- Admin API root: `StonegateOS/apps/api/app/api/admin`
- Many Team Console “server actions” live in: `StonegateOS/apps/site/src/app/team/actions.ts`

Major areas:
- **Inbox** (SMS/email/DM/calls) + AI drafts/suggestions
- **Contacts** and **Pipeline**
- **Calendar** + “My Day” ops workflow + marking jobs done (revenue capture happens when jobs are closed out)
- **Partners** (partner users, rate cards, partner bookings)
- **Marketing** (Google Ads insights + first-party web analytics)
- **Policy/Automation/Access** controls

Authentication:
- Admin login: `StonegateOS/apps/site/src/app/admin/login`
- Sessions are stored in DB tables (`team_sessions`, `partner_sessions`) and enforced via API middleware/helpers.

---

## Unified Inbox + Messaging

Channels supported:
- SMS (Twilio)
- Calls (Twilio call status + missed call logging)
- Meta (Messenger + lead ads)
- Email (SMTP)
- “DM webhook” (optional, internal notifications)

Core inbox logic:
- Inbound ingestion normalizes messages into `conversation_threads` + `conversation_messages`
  - Helper: `StonegateOS/apps/api/src/lib/inbox.ts` (via `recordInboundMessage`)
- Outbound messaging is queued via `outbox_events` and sent by the outbox worker through:
  - `StonegateOS/apps/api/src/lib/messaging.ts`

Twilio webhooks:
- SMS: `StonegateOS/apps/api/app/api/webhooks/twilio/sms/route.ts`
- Voice missed-call logger: `StonegateOS/apps/api/app/api/webhooks/twilio/voice/route.ts`
- Call status callback: `StonegateOS/apps/api/app/api/webhooks/twilio/call-status/route.ts`
- Outbound connect/escalation TwiML:
  - `StonegateOS/apps/api/app/api/webhooks/twilio/connect/route.ts`
  - `StonegateOS/apps/api/app/api/webhooks/twilio/escalate/route.ts`

Important note:
- The current inbound voice handlers primarily **record/log** missed calls and call status; inbound call screening/blocking requires routing Twilio’s “A call comes in” to a TwiML gate that can `<Reject/>` (see Twilio console guidance).

---

## Outbox Worker (Background Automation)

Why it exists:
- Keep user-facing requests fast.
- Make notifications/retries reliable (durable queue in DB).

How it works:
1. API routes insert rows into `outbox_events`.
2. Worker (`StonegateOS/scripts/outbox-worker.ts`) polls and calls:
   - `processOutboxBatch`: `StonegateOS/apps/api/src/lib/outbox-processor.ts`
3. The processor:
   - Sends SMS/email/DM
   - Runs follow-up sequences + sales autopilot
   - Schedules/reminders/confirmation loops
   - Syncs Google Ads insights + runs analyst reports
   - Runs call transcription/coaching flows (if enabled + recordings available)
   - Tracks provider health in `provider_health`

Key env toggles referenced in code:
- `SALES_ESCALATION_CALL_ENABLED` (call escalation feature gate)
- `SALES_AUTO_FIRST_TOUCH_SMS_ENABLED` (auto first-touch behavior)
- Worker tuning in `StonegateOS/.env.example` (`OUTBOX_*`, SEO + Google Ads intervals)

Operational doc:
- `StonegateOS/docs/outbox-worker.md`

---

## Partner Portal (`/partners`)

Partner portal lives on the Site app, backed by API “portal” routes.

Site UI:
- `StonegateOS/apps/site/src/app/partners`

API (partner-authenticated):
- `StonegateOS/apps/api/app/api/portal`
  - `GET /api/portal/me`
  - `GET/POST /api/portal/properties`
  - `GET/POST /api/portal/bookings` (+ cancel route)
  - `GET /api/portal/rates` (rate card lookup)

Admin (staff) controls for partners:
- `StonegateOS/apps/api/app/api/admin/partners`

---

## Marketing + Analytics

First-party website analytics:
- Client emitter: `StonegateOS/apps/site/src/lib/web-analytics.ts`
- Ingestion endpoint: `StonegateOS/apps/api/app/api/public/web-events/route.ts`
- Dashboard lives in Team Console (tab `web-analytics`) and reads from:
  - `web_events`, `web_event_counts_daily`, `web_vitals`
- Doc: `StonegateOS/docs/web-analytics.md`

Google Ads insights + analyst:
- Data sync + storage in `google_ads_*` tables (see schema)
- Scheduler is run by the outbox worker:
  - `StonegateOS/apps/api/src/lib/google-ads-scheduler.ts`
  - `StonegateOS/apps/api/src/lib/google-ads-analyst-scheduler.ts`
- Dashboard lives in Team Console (tab `google-ads`)
- Doc: `StonegateOS/docs/marketing.md`

Meta (Facebook) integration:
- Webhooks live in: `StonegateOS/apps/api/app/api/webhooks/facebook/route.ts`
- Setup doc: `StonegateOS/docs/meta-facebook-setup.md`

---

## AI: Drafts, Autopilot, and Jarvis (Discord)

In-product AI (Team Console):
- Inbox suggestion/drafting and automation:
  - `StonegateOS/apps/api/src/lib/auto-replies.ts`
  - `StonegateOS/apps/api/src/lib/sales-autopilot.ts`

Discord agent worker (“Jarvis”):
- Entrypoint: `StonegateOS/scripts/discord-agent-bot.ts`
- Uses env vars under “Discord Agent (optional worker)” in `StonegateOS/.env.example`
- Designed to be conversational (no rigid command-only UX) and to require approval-before-action for sensitive operations.

Jarvis intent matrix doc (how it’s planned/structured):
- `StonegateOS/docs/jarvis/PHASE0_INTENT_MATRIX.md`

---

## Environment Variables (Single Reference)

The single best reference is:
- `StonegateOS/.env.example`

Production deployment expectations and how env vars map to Render services:
- `StonegateOS/DEPLOY-ON-RENDER.md`

---

## Where To Look When Something Breaks

Fast triage map:
- Public booking/quote UI: `StonegateOS/apps/site/src/components/LeadForm.tsx`
- Quote APIs: `StonegateOS/apps/api/app/api/junk-quote/route.ts`, `StonegateOS/apps/api/app/api/brush-quote/route.ts`, `StonegateOS/apps/api/app/api/demo-quote/route.ts`
- Booking APIs: `StonegateOS/apps/api/app/api/junk-quote/availability/route.ts`, `StonegateOS/apps/api/app/api/junk-quote/hold/route.ts`, `StonegateOS/apps/api/app/api/junk-quote/book/route.ts`
- Outbox processing: `StonegateOS/apps/api/src/lib/outbox-processor.ts` + worker `StonegateOS/scripts/outbox-worker.ts`
- Twilio webhooks: `StonegateOS/apps/api/app/api/webhooks/twilio`
- Policy/pricing issues: `StonegateOS/apps/api/src/lib/policy.ts` plus pricing-related modules under `StonegateOS/apps/api/src/lib` (search for “pricing”).

For “must not break” flows and what to test:
- `StonegateOS/docs/CRITICAL_FLOWS.md`
