# Debug Playbook (Where to Look First)

This is a “fast triage” doc for production and local debugging.

## Always start with: what service is failing?

StonegateOS is typically deployed as:
- `site` (public + Team Console UI)
- `api` (DB + business logic + webhooks)
- `outbox worker` (async jobs)
- optional `discord agent worker`

If something “didn’t happen later” (no SMS/call/reminder/automation), it’s often the worker.

---

## Public `/book*` issues

Symptoms:
- Quote fails / hangs
- Booking slots never load
- Booking fails (slot_full/day_full)

Where to look:
- UI: `StonegateOS/apps/site/src/components/LeadForm.tsx`
- Quote routes:
  - `StonegateOS/apps/api/app/api/junk-quote/route.ts`
  - `StonegateOS/apps/api/app/api/brush-quote/route.ts`
  - `StonegateOS/apps/api/app/api/demo-quote/route.ts`
- Booking routes:
  - `StonegateOS/apps/api/app/api/junk-quote/availability/route.ts`
  - `StonegateOS/apps/api/app/api/junk-quote/hold/route.ts`
  - `StonegateOS/apps/api/app/api/junk-quote/book/route.ts`

DB checks:
- `instant_quotes` row exists for the `quoteId`
- `appointment_holds` row exists for a hold
- `appointments` row is created on successful booking

---

## “Texts didn’t send” / “Auto follow-up didn’t run”

Understand the pipeline:
1) App queues an outbox event in `outbox_events`
2) Worker processes it and sends via provider
3) Provider webhooks update delivery status

Where to look:
- Outbox processor: `StonegateOS/apps/api/src/lib/outbox-processor.ts`
- Worker entrypoint: `StonegateOS/scripts/outbox-worker.ts`
- Outbox types list: `StonegateOS/docs/system/OUTBOX_EVENT_INDEX.md`

DB checks:
- Is there an unprocessed `outbox_events` row for the action?
- Does it have `lastError` and `attemptCount`?
- Is `nextAttemptAt` in the future?

Provider webhooks:
- Twilio SMS webhook: `StonegateOS/apps/api/app/api/webhooks/twilio/sms/route.ts`
- Provider health: `provider_health` table + `StonegateOS/apps/api/src/lib/provider-health.ts`

---

## “Inbound messages aren’t showing up”

Where to look:
- Twilio inbound: `StonegateOS/apps/api/app/api/webhooks/twilio/sms/route.ts`
- Inbox normalization: `StonegateOS/apps/api/src/lib/inbox.ts` (`recordInboundMessage`)

DB checks:
- `conversation_threads` row for the contact/channel
- `conversation_messages` row for the inbound message

---

## “Inbound calls aren’t creating leads / inbox threads”

Where to look:
- Missed call logger: `StonegateOS/apps/api/app/api/webhooks/twilio/voice/route.ts`
- Call status: `StonegateOS/apps/api/app/api/webhooks/twilio/call-status/route.ts`

Important:
- These handlers rely on Twilio being configured to hit the webhook(s).
- They are primarily for logging/status, not inbound call routing.

---

## Partner portal issues

Where to look:
- Site UI: `StonegateOS/apps/site/src/app/partners`
- API portal routes: `StonegateOS/apps/api/app/api/portal`
- Partner auth: `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`

DB checks:
- `partner_users` exists and is active
- session exists in `partner_sessions`
- `partner_rate_cards` + `partner_rate_items` exist for pricing

---

## Permissions/auth failures

Symptoms:
- `401 unauthorized` (missing admin key or session)
- `403 forbidden` (permission gate)

Where to look:
- Admin key gate: `StonegateOS/apps/api/app/api/web/admin.ts`
- Permission gate: `StonegateOS/apps/api/src/lib/permissions.ts`
- Team auth: `StonegateOS/apps/api/src/lib/team-auth.ts`
- Partner auth: `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`

---

## Google Ads dashboard is empty

Where to look:
- Scheduler: `StonegateOS/apps/api/src/lib/google-ads-scheduler.ts`
- Outbox handler: `StonegateOS/apps/api/src/lib/outbox-processor.ts` (`google.ads_insights.sync`)
- Env vars: `StonegateOS/.env.example` (GOOGLE_ADS_*)

---

## Fast “is it up?” checks

Health endpoints:
- API: `GET /api/healthz` (`StonegateOS/apps/api/app/api/healthz/route.ts`)
- Site: `GET /api/healthz` (`StonegateOS/apps/site/src/app/api/healthz/route.ts`)

