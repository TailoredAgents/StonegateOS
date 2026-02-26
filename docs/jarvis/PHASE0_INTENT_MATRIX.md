# Jarvis Phase 0 - Intent Matrix (Coverage-Driven)

Date: 2026-02-26

Goal: make Jarvis "omni-knowledgeable" by routing normal conversational questions (variable phrasing) to the *existing* StonegateOS sources of truth (API routes + DB tables), with deterministic fallbacks when something is unavailable or not configured.

This phase is **spec only** (no behavior changes): it defines the intent taxonomy, required entity extraction, and the tool/API mapping Jarvis must use so it never guesses "where data lives".

---

## Global conventions (apply to all intents)

### Time
- Interpret "today/yesterday/this week/next week" using `APPOINTMENT_TIMEZONE` (default `America/New_York`).
- If a request is ambiguous ("last week", "this month"), Jarvis asks **one** clarification question with choices.

### Money
- Always output both cents and formatted USD if available.
- If the system stores numeric strings (e.g. Google Ads `cost` is a numeric string), Jarvis parses to number for formatting but preserves raw values in logs.

### Disambiguation
- Prefer *not* asking follow-ups unless required to execute the intent.
- If multiple contacts match, return a short list (max 5) with distinguishing fields (name + phone + city) and ask "Which one?"

### Fallback rules (must be consistent)
- **Not configured**: explain which integration/config is missing (e.g. Google Ads not configured).
- **Unavailable**: endpoint failed/timeouts; ask user to retry.
- **No data**: integration configured but no rows yet; explain "no synced data yet".

---

## Intent catalog

Each intent includes:
- **What it answers**
- **Entity extraction**
- **API/tool source of truth**
- **Example utterances** (variable phrasing)
- **Fallback behavior**

---

## A) Business profile & policies (always authoritative)

### intent: `policy.get_all`
**Answers:** "What are our hours/service area/pricing summary/quiet hours/templates/etc.?"

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/policy` (see `apps/api/app/api/admin/policy/route.ts`)

**Example utterances:**
- "What's our service area again?"
- "What discount percent are we using?"
- "What do we say we don't take?"
- "What are quiet hours?"
- "Remind me of our hours."
- "What's our pricing summary?"
- "What do we do and not do?"
- "What's the booking style we want?"
- "What's our primary phone and business name?"

**Fallback:**
- If unavailable: "Policy Center data unavailable right now."

---

## B) System health & provider status

### intent: `system.health`
**Answers:** "Why are texts failing?", "Is Google Ads down?", "Is site URL configured?"

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/system/health` (see `apps/api/app/api/admin/system/health/route.ts`)

**Example utterances:**
- "Any system warnings?"
- "Why didn't SMS send?"
- "Is Twilio configured?"
- "Is the calendar integration healthy?"
- "Are we degraded anywhere?"
- "Why am I seeing email_not_configured?"
- "Is the website URL env set correctly?"
- "Are calls enabled right now?"

**Fallback:**
- If unavailable: "Health check unavailable right now."

---

## C) Website analytics + /book funnel

### intent: `web.analytics.summary`
**Answers:** visits, page views, call clicks, /book step metrics, quote shown, self-serve bookings, booked-any-channel.

**Entities:**
- `rangeDays` in {1,7,14,30} (default 7)
- optional `utmCampaign` (supported by API)

**Source of truth (read):**
- `GET /api/admin/web/analytics/summary?rangeDays=...` (see `apps/api/app/api/admin/web/analytics/summary/route.ts`)

**Example utterances:**
- "What happened on the site today?"
- "How many visits today?"
- "How many page views today?"
- "Any call clicks today?"
- "How did /book do this week?"
- "How many people got to step 1?"
- "How many submitted the form?"
- "How many quotes were shown?"
- "How many booked themselves?"
- "How many booked total (including when we booked them)?"

**Fallback:**
- If unavailable: "Website analytics unavailable right now."

### intent: `web.analytics.funnel`
**Answers:** step-to-step funnel counts and service area bucket split.

**Entities:** `rangeDays` in {1,7,14,30}.

**Source of truth (read):**
- `GET /api/admin/web/analytics/funnel?rangeDays=...` (see `apps/api/app/api/admin/web/analytics/funnel/route.ts`)

**Example utterances:**
- "Where are people dropping off?"
- "Is submit to quote leaking?"
- "How many reached step 2?"
- "What's the quote shown rate?"
- "What's the self-serve booking rate?"
- "How many are unknown service area?"

**Fallback:**
- If many visits show `unknown`, explain: `web_events.in_area_bucket` wasn't set for those visits.

### intent: `web.analytics.errors`
**Answers:** tracked failure events (e.g. `*_fail`) in last N days.

**Entities:** `rangeDays`.

**Source of truth (read):**
- `GET /api/admin/web/analytics/errors?rangeDays=...` (see `apps/api/app/api/admin/web/analytics/errors/route.ts`)

**Example utterances:**
- "Any tracked errors today?"
- "What failed in the funnel this week?"
- "Are we seeing upload failures?"

### intent: `web.analytics.vitals`
**Answers:** web vitals p75 by path/metric/device.

**Entities:** `rangeDays`.

**Source of truth (read):**
- `GET /api/admin/web/analytics/vitals?rangeDays=...` (see `apps/api/app/api/admin/web/analytics/vitals/route.ts`)

**Example utterances:**
- "How fast is /book?"
- "Any performance issues on mobile?"
- "Show web vitals for the last 7 days."

---

## C2) Google Ads (Marketing tab)

### intent: `google.ads.spend`
**Answers:** Google Ads spend for today/yesterday (or a specific date), optionally scoped to a campaign.

**Entities:**
- `relative` in {today, yesterday} OR `date` in `YYYY-MM-DD`
- optional `campaignId`

**Source of truth (read):**
- `GET /api/admin/google/ads/spend?relative=...` OR `GET /api/admin/google/ads/spend?date=...` (see `apps/api/app/api/admin/google/ads/spend/route.ts`)

**Example utterances:**
- "What did we spend on Google Ads yesterday?"
- "Google Ads spend today?"
- "How much did we spend on Ads on 2026-02-20?"

### intent: `google.ads.summary`
**Answers:** multi-day Google Ads rollups (clicks, impressions, spend, conversions) for a window.

**Entities:** `rangeDays` (default 7; max 30).

**Source of truth (read):**
- `GET /api/admin/google/ads/summary?rangeDays=...` (see `apps/api/app/api/admin/google/ads/summary/route.ts`)

**Example utterances:**
- "Google Ads results last 7 days."
- "How are Google ads doing this month?" (Jarvis should map to `rangeDays=30` unless clarified)

### intent: `google.ads.status`
**Answers:** whether Google Ads is configured + last sync status (for troubleshooting).

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/google/ads/status` (see `apps/api/app/api/admin/google/ads/status/route.ts`)

**Example utterances:**
- "Is Google Ads connected?"
- "Did the Google Ads sync run?"

---

## D) Revenue, expenses, P&L (StonegateOS "real revenue" = completed jobs)

### intent: `finance.revenue.summary`
**Answers:** revenue rollups by window (MTD/last30/YTD) based on completed appointments.

**Entities:** none (endpoint returns the standard windows).

**Source of truth (read):**
- `GET /api/revenue/summary` (see `apps/api/app/api/revenue/summary/route.ts`)

**Important:** revenue is computed from `appointments.final_total_cents` (fallback `quoted_total_cents`) for `status='completed'`.

**Example utterances:**
- "What's revenue month to date?"
- "What's revenue last 30 days?"
- "What's revenue year to date?"
- "How many completed jobs this month?"
- "How many jobs did we complete last 30 days?"

### intent: `finance.expenses.summary`
**Answers:** expense rollups by window + daily totals last 7 days.

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/expenses/summary` (see `apps/api/app/api/admin/expenses/summary/route.ts`)

**Example utterances:**
- "How much did we spend this month?"
- "Expenses last 30 days?"
- "What did we spend this week?"
- "Daily spend the last 7 days?"

### intent: `finance.expenses.list`
**Answers:** recent expense list; filter by from/to.

**Entities:**
- `limit` (default 25)
- optional `from`, `to` ISO datetimes

**Source of truth (read):**
- `GET /api/admin/expenses?limit=...&from=...&to=...` (see `apps/api/app/api/admin/expenses/route.ts`)

**Example utterances:**
- "Show me recent expenses."
- "List the last 25 expenses."
- "What did we spend between Feb 1 and Feb 15?"

### intent: `finance.pnl`
**Answers:** P&L = revenue summary minus expenses summary (same windows).

**Entities:** none.

**Source of truth:** computed from:
- `finance.revenue.summary`
- `finance.expenses.summary`

**Example utterances:**
- "What's profit month to date?"
- "What's our P&L last 30 days?"
- "How much did we make after expenses this month?"

**Fallback:**
- If either unavailable: "I can't compute P&L right now because revenue/expenses data is unavailable."

---

## E) Schedule & appointments

### intent: `schedule.summary`
**Answers:** appointment counts by status and by day for a range.

**Entities:**
- `range` in {today, tomorrow, this_week, next_week} (default this_week)
- optional `statuses` filter (comma list)

**Source of truth (read):**
- `GET /api/admin/schedule/summary?range=...&statuses=...` (see `apps/api/app/api/admin/schedule/summary/route.ts`)

**Example utterances:**
- "How many appointments tomorrow?"
- "What's the schedule this week?"
- "How many confirmed today?"
- "How busy are we next week?"
- "How many cancellations this week?"

### intent: `appointments.list`
**Answers:** list appointments (used by My Day, calendar drilldowns, per-contact history).

**Entities:**
- `status` in {requested, confirmed, completed, no_show, canceled, all} (supports comma list)
- optional `contactId`, `propertyId`
- optional `limit`

**Source of truth (read):**
- `GET /api/appointments?status=...&contactId=...&propertyId=...&limit=...` (see `apps/api/app/api/appointments/route.ts`)

**Example utterances:**
- "List confirmed appointments."
- "Show completed jobs."
- "Show appointments for this contact."

---

## F) Commissions

### intent: `commissions.summary`
**Answers:** next payout period totals by role.

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/commissions/summary` (see `apps/api/app/api/admin/commissions/summary/route.ts`)

**Example utterances:**
- "How much commission is owed this pay period?"
- "What's the next payout total?"
- "Break down commissions by role."

---

## G) CRM / pipeline / contacts

### intent: `crm.pipeline`
**Answers:** lane lists by stage, out-of-area flags, last activity per contact.

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/crm/pipeline` (see `apps/api/app/api/admin/crm/pipeline/route.ts`)

**Example utterances:**
- "Who's in quoted right now?"
- "What leads are new?"
- "Any out-of-area leads in pipeline?"
- "Who needs a follow up?"

### intent: `crm.contacts.search`
**Answers:** find contacts by name/phone/email/address fragments; supports pagination.

**Entities:**
- `q` (string)
- `limit`, `offset`
- optional flags `excludeOutbound`, `onlyOutbound`

**Source of truth (read):**
- `GET /api/admin/contacts?q=...&limit=...&offset=...` (see `apps/api/app/api/admin/contacts/route.ts`)

**Example utterances:**
- "Pull up Amy Wojcik."
- "Find the lead from 30188."
- "Search contacts for 404-777-2631."
- "Look up the customer at 123 Main St."

---

## H) Inbox / conversations (omni context per lead/thread)

### intent: `inbox.threads.list`
**Answers:** list threads with filters (q/status/channel/contactId).

**Entities:**
- `q`, `status` in {open,pending,closed}, `channel` in {sms,email,dm,call,web}
- `contactId`
- `limit`, `offset`

**Source of truth (read):**
- `GET /api/admin/inbox/threads?...` (see `apps/api/app/api/admin/inbox/threads/route.ts`)

**Example utterances:**
- "Show me open texts."
- "Find the conversation with Amy."
- "Search inbox for 'couch'."
- "Pull up Devon's most recent inbound."

### intent: `inbox.thread.messages`
**Answers:** fetch thread messages + media metadata.

**Entities:** `threadId`, pagination.

**Source of truth (read):**
- `GET /api/admin/inbox/threads/{threadId}/messages` (see `apps/api/app/api/admin/inbox/threads/[threadId]/messages/route.ts`)

### intent: `inbox.thread.suggest_reply`
**Answers:** draft/suggest reply that respects "known facts" and avoids redundant questions.

**Entities:**
- `threadId`
- optional "tone" (friendly/short/firm), "goal" (book / follow up / confirm)

**Source of truth (read+LLM):**
- `POST /api/admin/inbox/threads/{threadId}/suggest` (see `apps/api/app/api/admin/inbox/threads/[threadId]/suggest/route.ts`)

**Notes:**
- Suggest relies on `loadOmniThreadFacts` (`apps/api/src/lib/omni-thread-context.ts`) which pulls pipeline stage, latest lead, instant quote (photos + optional price), next appointment, and other-channel threads.

**Example utterances:**
- "Suggest a reply."
- "Draft something friendly."
- "Write a short response that gets them booked."
- "Reply without asking for info we already have."

---

## I) Outbound

### intent: `outbound.queue`
**Answers:** what's due/overdue, filters by campaign, attempt, has phone/email, etc.

**Entities:** `memberId`, `q`, `campaign`, `due`, `has`, `attempt`, pagination.

**Source of truth (read):**
- `GET /api/admin/outbound/queue?...` (see `apps/api/app/api/admin/outbound/queue/route.ts`)

**Example utterances:**
- "What should Devon call next?"
- "Show overdue outbound tasks."
- "Who's due now?"
- "Any callbacks today?"

---

## J) Partners

### intent: `partners.list`
**Answers:** partner/prospect lists with touch timing and owner assignment.

**Entities:** `status`, `ownerId`, `type`, `q`, pagination.

**Source of truth (read):**
- `GET /api/admin/partners?...` (see `apps/api/app/api/admin/partners/route.ts`)

**Example utterances:**
- "List partners due for a touch."
- "Any new partner prospects?"
- "Show inactive partners."

---

## K) SEO agent

### intent: `seo.status`
**Answers:** last run status + recent published posts.

**Entities:** none.

**Source of truth (read):**
- `GET /api/admin/seo/status` (see `apps/api/app/api/admin/seo/status/route.ts`)

**Example utterances:**
- "Did the SEO agent run recently?"
- "Any blog posts published this week?"
- "When can we autopublish next?"

---

## L) Meta Ads (supported even if not shown in UI)

### intent: `meta.ads.summary`
**Answers:** spend/leads/conversions by campaign or ad (based on stored insights + lead form payload ids).

**Entities:**
- `since`, `until` (ISO date) OR default last 30 days
- `level` in {campaign, ad} (default campaign)

**Source of truth (read):**
- `GET /api/admin/meta/ads/summary?level=...&since=...&until=...` (see `apps/api/app/api/admin/meta/ads/summary/route.ts`)

**Example utterances:**
- "How are Facebook ads doing?"
- "What did we spend on Meta last 30 days?"
- "Cost per lead by campaign?"
- "Show ads with the most spend."

---

## Write actions (defined now; implemented later with approval)

These intents exist for completeness, but must be executed only after Discord/thread approval (Phase 5).

- `action.send_text` (contact/thread -> send SMS/DM/email)
- `action.reschedule_appointment`
- `action.schedule_appointment`
- `action.create_contact`
- `action.create_property`
- `action.add_note_or_task`
- `action.apply_google_ads_recommendation` / `action.apply_negative_keywords`

Each action must:
1) Resolve entities (contact/appointment/campaign).
2) Read back a proposed action in plain English.
3) Wait for "approve" in the same thread before executing.

---

## Phase 0 exit criteria

Phase 0 is "done" when every Team Console domain already present (Google Ads, Web Analytics, Owner HQ, Expenses, Pipeline, Inbox, Outbound, Partners, SEO, Policy, Health) has:
- at least one intent,
- an explicit route mapping,
- a minimal entity extraction spec,
- fallback rules,
- and sample utterances demonstrating "normal conversation" phrasing.
