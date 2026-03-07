# Outbox Events (Contract + Behavior)

StonegateOS uses a DB-backed queue (`outbox_events`) for reliable, retryable background work.

## Why the outbox exists
- Keep request/response endpoints fast (UI and public funnel stay responsive).
- Make notifications and automation durable (crash/redeploy safe).
- Centralize retries + provider health tracking.

## Where it runs
- Worker entrypoint: `StonegateOS/scripts/outbox-worker.ts`
- Processor (the “dispatcher”): `StonegateOS/apps/api/src/lib/outbox-processor.ts`

## Storage
- Table: `outbox_events` in `StonegateOS/apps/api/src/db/schema.ts`
- Common fields: `type`, `payload` (JSON), `attemptCount`, `processedAt`, `nextAttemptAt`, `lastError`

## Processing loop
1. API routes insert `outbox_events` rows.
2. Worker polls and calls `processOutboxBatch({ limit })`.
3. Processor loads unprocessed events, runs handler per `type`, and marks:
   - processed (sets `processedAt`)
   - skipped (e.g., missing payload)
   - retry (sets `nextAttemptAt` and increments attempt counters)

## Retries + idempotency (current)
- Message send retries are bounded (see `MAX_MESSAGE_SEND_ATTEMPTS` in `outbox-processor.ts`).
- Some events include dedupe protection via message metadata keys or “already queued” checks upstream.
- The outbox is intended to be **at-least-once**; handlers should be idempotent or tolerate duplicates.

## Event inventory

Use these references:
- Type index (type → queue sources → handler lines): `StonegateOS/docs/system/OUTBOX_EVENT_INDEX.md`
- Generated route indexes often show where events originate:
  - `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`

Below is the intended semantic contract per event family.

### Messaging

- `message.send`
  - Payload: `{ messageId: string }`
  - Purpose: deliver an already-created `conversation_messages` row via the appropriate provider (Twilio/SMTP/DM).
  - Source example: `StonegateOS/apps/api/src/lib/system-outbound.ts` (queues system messages).

- `message.received`
  - Payload: `{ messageId: string, threadId: string, channel: string }`
  - Purpose: trigger post-ingest automation (e.g., auto-replies / sales autopilot) after inbound messages are recorded.
  - Source example: `StonegateOS/apps/api/src/lib/inbox.ts`

### Leads / pipeline automation

- `lead.created`
  - Payload: varies by creator; used to kick downstream automation when a lead is created.

- `lead.alert`
  - Payload: `{ leadId: string, source?: string }`
  - Purpose: alert team (SMS/DM/email) that a new lead arrived.
  - Sources: quote endpoints + missed call flow + booking flow.

- `pipeline.auto_stage_change`
  - Payload: `{ contactId: string, fromStage?: string|null, toStage: string, reason: string, meta?: object }`
  - Purpose: record or notify about automatic pipeline stage changes driven by system events.

### Follow-up cadence

- `followup.schedule`
  - Payload: `{ leadId: string, contactId: string, reason?: string }`
  - Purpose: schedule follow-up sequence for a new lead (creates `followup.send` events at future times).

- `followup.send`
  - Payload: typically includes `{ leadId: string, step?: number }` (exact keys depend on scheduler).
  - Purpose: execute the next follow-up step (SMS/email) if the lead is still eligible.

### Appointment / estimate notifications

- `estimate.requested`
  - Purpose: notify a customer/team about an estimate appointment being requested/created.

- `estimate.rescheduled`
  - Purpose: notify parties about a reschedule.

- `estimate.reminder`
  - Purpose: reminder loop before the appointment (subject to quiet hours).

- `estimate.status_changed`
  - Purpose: track and notify on appointment status transitions (confirmed/completed/canceled/no_show).

### Quote lifecycle

- `quote.sent`
  - Purpose: deliver a quote link and record quote-sent notifications.

- `quote.decision`
  - Purpose: handle “accepted/declined” decisions (notify team, update pipeline, etc.).

### Reviews

- `review.request`
  - Purpose: send review request after a completed job (policy-controlled).

### Sales autopilot and escalation

- `sales.autopilot.draft`
  - Purpose: generate an AI draft reply for a thread/contact (stored as draft or queued message).

- `sales.autopilot.autosend`
  - Purpose: send an approved/eligible autopilot message (bounded retries).

- `sales.queue.nudge.sms`
  - Purpose: internal “nudge” messages to the sales team for stale leads/threads.

- `sales.escalation.call`
  - Purpose: initiate an outbound call connect/escalation flow (policy + env gated).

### Provider sync / analytics jobs

- `google.ads_insights.sync`
  - Payload: `{ days: number, invokedBy: 'worker'|'admin' }`
  - Purpose: fetch Google Ads metrics into `google_ads_*` tables.

- `google.ads_analyst.run`
  - Purpose: run the analyst report/recommendation pipeline and store results.

- `meta.ads_insights.sync`
  - Purpose: fetch Meta ads insights into `meta_ads_insights_daily`.

- `meta.lead_event`
  - Purpose: log/forward Meta lead events (conversions dataset, etc.).

### Call recordings

- `call.recording.process`
  - Purpose: fetch/transcribe/score a call recording (Twilio recordings + OpenAI transcription/scoring).

- `call.recording.delete`
  - Purpose: cleanup recordings on provider side if configured.

