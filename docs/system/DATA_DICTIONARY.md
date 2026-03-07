# Data Dictionary (Curated)

This is the “what does this table mean?” guide. For an exhaustive generated list of columns per table, see:
- `StonegateOS/docs/system/DATA_DICTIONARY_COLUMNS.md`

Source of truth:
- `StonegateOS/apps/api/src/db/schema.ts`

---

## The spine (most features hang off these)

### `contacts`
Represents people/orgs you interact with (customers, callers, partners, internal).
Common relationships:
- 1 contact → many `properties`
- 1 contact → many `leads`
- 1 contact → many `conversation_threads`
- contact may have partner fields (`partnerStatus`, referral counters, etc.)

### `properties`
Service addresses (job sites) tied to a contact.
Used by:
- booking address, service history, partner bookings

### `leads`
Represents an inbound opportunity (from web quote, missed call, Meta lead ad, etc.).
Used by:
- pipeline stages, follow-up sequences, lead alerts

### `instant_quotes`
Represents the result of a `/book*` “instant quote / estimate range” request.
Used by:
- booking (`instantQuoteId` drives availability/hold/book)
- linking quote details to the CRM and to text alerts

### `appointments`
Scheduled work/estimates.
Used by:
- calendar views, reminders, confirmations, “My Day”, revenue capture at completion

### `conversation_threads` and `conversation_messages`
Unified inbox model.
- Thread = one conversation per contact per channel (sms/email/dm/call)
- Message = inbound/outbound messages with delivery status + metadata
Provider webhooks ingest into these tables.

### `outbox_events`
Durable async job queue.
Used by:
- notifications, follow-ups, autopilot drafts/autosends, marketing sync, call processing

---

## Operational / automation tables

### `crm_pipeline`
Stores pipeline stage per contact (new/contacted/qualified/quoted/won/lost).

### `crm_tasks`
General tasks/reminders (follow-up tasks, ops tasks, etc.).

### `lead_automation_states`
Tracks follow-up state and stop conditions for a lead (DNC, stopped, next follow-up time, etc.).

### `provider_health`
Health check signals for providers (Twilio/SMTP/Meta/Google Ads) based on recent sends/errors.

---

## Partners

### `partner_users`, `partner_sessions`, `partner_login_tokens`
Partner portal auth and sessions.

### `partner_rate_cards`, `partner_rate_items`
Partner-specific pricing by service + tier.

### `partner_bookings`
Tracks partner-created bookings and ties them to an `appointments` row.

---

## Marketing + analytics

### `web_events`, `web_event_counts_daily`, `web_vitals`
First-party public-site analytics, including `/book*` funnel events.
Raw retention is pruned (default 30 days).

### `google_ads_*` tables
Stores Google Ads metrics and analyst artifacts used by the Team Console dashboards and Jarvis reports.

### `meta_ads_insights_daily`
Stores Meta Ads aggregated metrics (if enabled).

---

## Money

### `expenses`
Operational expenses tracked in Owner HQ / Ops.

### Revenue capture (appointments)
Revenue is captured on `appointments`:
- `appointments.quotedTotalCents` (what was quoted/estimated)
- `appointments.finalTotalCents` (final amount recorded at job completion)

Revenue summaries are served by API routes such as:
- `StonegateOS/apps/api/app/api/revenue/summary/route.ts`
- Team Console “My Day” completion flow (UI in `apps/site/src/app/team`)

### Commissions / payouts
If enabled, commissions and payout runs are tracked in tables such as:
- `commission_settings`, `appointment_commissions`, `payout_runs`, `payout_run_lines`

---

## Auditing + security

### `audit_logs`
System and user actions (message received, calls started, pipeline changes, etc.).

### `team_members`, `team_roles`, `team_sessions`, `team_login_tokens`
Staff auth, roles, sessions.
