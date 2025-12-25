# StonegateOS Roadmap (Extension Plan)

## Purpose and scope
- This roadmap extends the existing StonegateOS repo. No new project or replatforming.
- In scope: new tables, endpoints, UI, and automations inside `apps/api`, `apps/site`, `apps/app`, and the worker.
- Out of scope: separate repos, full UI redesign, or replacing the current stack.

## Current state (already built)
- CRM model: contacts, properties, leads, appointments, quotes, pipeline, tasks, payments, instant quotes, blog.
- Public site, scheduling flow, Team Console, Owner Hub.
- Quote lifecycle with share tokens and decisions.
- Outbox worker for notifications, calendar sync, and SEO autopublish.
- Calendar sync + webhook handling.
- SMS/email capability via Twilio and SMTP when configured.
- Public/team/owner chat endpoints.

## Phase 1 - Launch critical (Dec 27)

### Business Settings / Policy Center (cross-cutting)
Goal: Central place to configure business rules instead of hardcoding.

Task sequence:
1) Business hours + quiet hours per channel.
2) Service area boundaries + travel fee rules.
3) Default booking windows + buffers + max jobs/day/crew.
4) Standard job definition (what AI can auto-book).
5) Item policies (what you don’t take / extra fees).
6) Templates library (first touch, follow-up, confirmations, reviews).

Done when:
- Ops can adjust policies without code changes.

### Access Control & Audit (cross-cutting)
Goal: Controlled access and traceability for automations and actions.

Task sequence:
1) Roles: Owner / Office / Crew / Read-only.
2) Permissions: who can send messages, modify policies, mark paid, merge contacts, etc.
3) Audit log: who/what did what (AI/worker/human), when, and context.

Done when:
- You can answer “who sent/booked/paused/merged and why” instantly.

### A) Unified Inbox + Conversation Threads
Goal: One timeline per lead with all channels and replies from the console.

Task sequence:
1) Data model: add conversation threads, messages, participants, and channel metadata.
2) Ingestion: normalize inbound SMS/email/DM events into thread messages.
3) API: list threads by lead, fetch thread history, send message endpoints.
4) Team Console: inbox list, thread view, send panel, and lead linkage.
5) Automation hooks: "new inbound message" outbox event for alerts.
6) Identity/merge rules: phone/email exact match -> same contact; address + similar name -> suggest merge; manual merge action; pick primary thread when sources collide.
7) Merge review queue: suggested merges with confidence; approve/decline; never auto-merge on weak signals.
8) Conversation state machine: new → qualifying → photos received → estimated → offered times → booked → reminder → completed → review. Guardrails to avoid re-asking answered questions; limit asks to 1–2 at a time.
9) Message delivery state: queued → sent → delivered/failed (where provider supports); retry rules; failed-sends queue; provider health indicator (SMS/email/calendar).

Done when:
- Every lead shows a single threaded timeline.
- Messages can be sent from inside the console.
- New inbound messages link to a lead or create a new one without duplicate sprawl.

Dependencies/notes:
- SMS (Twilio), email (SMTP/IMAP or webhook), and any DM bridges available.

### B) Speed-to-Lead Automations (missed call + instant reply)
Goal: First response within 2 minutes across all channels.

Task sequence:
1) Define "first touch" templates by channel (SMS/FB/Nextdoor/email).
2) Wire missed call -> auto SMS thread + lead creation.
3) Wire FB/Nextdoor inbound -> auto reply + lead creation/merge.
4) Add "auto-reply sent" markers on the lead timeline.
5) Geo policy: enforce service area boundaries; travel fee rules; polite decline/alternative when out of area.
6) Channel sequencing: Phase 1 v1 focuses on SMS + missed call + email as fully controlled; FB/Nextdoor ingest/respond but steer to SMS for booking if platform limits show.
7) Automation modes per channel: Draft-only, Auto reply + human book, Full auto for standard jobs.

Done when:
- Missed calls create a lead and start an SMS thread.
- DM leads receive a reply within 2 minutes.
- Team can see auto-reply status in the thread.

Dependencies/notes:
- Call provider integration for missed call triggers.
- Nextdoor automation may be limited; route to SMS/email when needed.

### C) Booking Flow: Two time options + appointment hold
Goal: Convert chats into scheduled appointments without human involvement for standard jobs.

Task sequence:
1) Availability model: generate two time windows based on capacity and geography.
2) Hold tokens: reserve a slot for a short window (auto-expire).
3) Confirm booking: create appointment and send confirmation + reminders; define "standard job" constraints (size/complexity).
4) Reschedule flow: self-serve updates and calendar sync.
5) Confirmation loop: night-before YES/NO; morning-of if unconfirmed; auto-reschedule link if no response.
6) Automation modes: AI drafts vs full auto booking; per channel/job type.

Done when:
- Assistant offers two windows and can book a standard job end-to-end.
- Confirmations and reminders are sent automatically.
- Holds expire cleanly without double-booking.

Dependencies/notes:
- Calendar sync must be reliable; appointment time zone must be correct.

### D) Follow-up sequences (quoted-but-not-booked)
Goal: Automated follow-up that stops when the lead replies or books.

Task sequence:
1) Define sequence templates and timing (new lead, quote sent, no response).
2) Add follow-up state machine and schedule entries via outbox.
3) Implement stop rules (reply, booking, decline).
4) Surface follow-up status in Team Console.
5) Compliance: STOP handling for SMS, email unsubscribe, quiet hours per channel, per-channel prefs.
6) Kill switches: per-lead "pause all automations," per-channel "Do Not Contact," and "human takeover" mode to block AI replies until released.
7) Automation modes: draft-only, approval required, auto-send; per channel.

Done when:
- Each lead shows "follow-up running" with next step/time.
- Follow-up stops instantly on reply or booking.
- Team can pause or end a sequence manually.

## Phase 2 - Fill 2 crews (7-8 jobs/day)

### E) Humanistic voice model + reasoning fallback
Goal: Consistent, short, confident Stonegate voice with safe escalation.

Task sequence:
1) Write tone rules and message templates by channel.
2) Add "edge case" detection and fallback response paths.
3) Add "AI disclosure if asked" behavior.
4) Item policy rules: what we don't take, what costs extra, clarifying questions for hazmat/appliances/mattresses.

Done when:
- Replies feel human and on-brand.
- Edge cases escalate cleanly and quickly.

### F) Handoff rules + "loop in human"
Goal: Clear triggers and fast human takeover.

Task sequence:
1) Define escalation triggers (commercial, hazmat, angry, discount requests).
2) Add "needs human" state on threads and leads.
3) Add a one-click "take over" button in the console.
4) Service-area/complexity triggers: out-of-area, commercial, heavy/specialty items route to human.
5) Escalation SLA: assign to owner/assistant; SLA timers and re-pings; "hot lead" indicator (same-day intent, photos, price asks).

Done when:
- Leads are flagged with a reason.
- Human can take over instantly in the same thread.

### G) Job closeout flow (crew completion)
Goal: Clean revenue capture without Stripe.

Task sequence:
1) Add closeout form: volume fraction, final price, payment method, notes, photos.
2) Operational proof: before/after photos, dump ticket upload, crew notes in timeline.
3) Store closeout data on appointment/job records.
4) Surface unpaid vs paid jobs in Owner Hub.
5) Manual overrides: mark paid/unpaid with reason; resend confirmation; restart follow-up; force book (bypass hold) in emergencies.

Done when:
- Every completed job has final price and payment method.
- Unpaid jobs are visible in under 10 seconds.

### H) Bank upload + reconciliation (manual-first accounting)
Goal: Simple P and L without Stripe.

Task sequence:
1) Upload bank CSV/OFX.
2) Categorize transactions (fuel, dump, marketing, etc.).
3) Match deposits to jobs where possible.
4) Add "needs review" queue.

Done when:
- Owner Hub shows weekly revenue/expenses and unmatched items.

### I) Reviews + referrals automation
Goal: Consistent reviews and referrals after job completion.

Task sequence:
1) Auto review request after closeout.
2) Follow-up nudge if no review.
3) Referral ask after review or completion.

Done when:
- Review requests are automatic and trackable.
- Review rate is visible by crew.

### Owner Brief v1 (shift earlier)
Goal: Daily clarity without dashboards.

Task sequence:
1) Generate daily digest: yesterday's leads/booked/completed/missed/response time.
2) Include follow-up conversions and today's utilization.
3) Add "top 3 actions" (e.g., call these leads, confirm these jobs, fix these no-shows).

Done when:
- Owner can read a single brief to steer the day and spend.

## Phase 3 - Scale to 3 trailers (spring readiness)

### J) Capacity + routing optimization
Goal: Cluster jobs to reduce deadhead miles.

Task sequence:
1) Add location clustering by day.
2) Suggest appointment windows based on geography.
3) Add "day plan" view for dispatch.

Done when:
- Schedule is naturally grouped by area.
- Suggested windows improve drive time.

### K) Marketing attribution + CPA reporting
Goal: Booked CPA by channel.

Task sequence:
1) Normalize lead source tagging across channels.
2) Attribute bookings to sources.
3) Spend ingestion: manual daily spend entry (v1) or upload/ingest (v2) by channel/campaign/day.
4) Owner brief: spend, leads, booked, CPA.
5) Funnel events: lead created, qualified, quote sent, appointment booked, job completed, paid (manual), review left.

Done when:
- CPA by channel is visible daily.

### L) Yard sign tracking
Goal: Know which zones work.

Task sequence:
1) Add sign zones and unique numbers/QRs.
2) Auto-tag leads by zone.
3) Report ROI per zone.

Done when:
- Best zones are measurable and visible.

## Phase 4 - Power ups

### M) Voice AI (after-hours + overflow)
Goal: Capture missed calls and convert to SMS/booking.

### N) Ads autopilot (guardrailed)
Goal: Recommend budget shifts and pause low performers with audit logs.

### O) SEO engine upgrade (local dominance)
Goal: Service + area pages, schema, internal linking, proof blocks.

## Dependencies and constraints
- Twilio and SMTP credentials must be configured for outbound messaging.
- Call tracking provider required for missed call automation.
- Nextdoor automation may be limited; route to SMS/email where possible.
- Bank export formats vary; define the first supported format (CSV or OFX).
- Define "standard job" boundaries and default booking windows/buffers.
- Provider health: define expected SMS/email/calendar provider status/alerts.

## Rollout and testing
- Add E2E coverage for each Phase 1 feature before launch.
- Staged rollout: enable automations for a subset of leads first.
- Add monitoring for outbox backlog, failed sends, booking errors; system status view in Owner Hub.
- Data migration/backfill: create default threads for legacy leads/quotes; pick primary thread; backfill visibility so old records show in the new inbox.

## Metrics and KPIs
- Speed-to-lead (target < 2 minutes)
- Booking rate
- Follow-up conversion rate
- Review rate
- Jobs per day per crew
- Booked CPA by channel

## Risks and edge cases
- Double booking if holds expire incorrectly.
- Timezone drift between site, API, and calendar.
- Channel outages causing lead loss.
- Identity duplication if merge rules are weak.

## Open questions (to resolve before Phase 1 build)
- What is the preferred escalation threshold for discounts and disputes?
- What channel has priority when multiple exist (SMS vs email vs DM)?
- Review request cadence (timing and number of nudges).
- What counts as a "standard job" the AI can book without approval (size/complexity/items)?
- Default booking windows and buffers (e.g., 2-hour window, 30-min buffer, latest bookable time).
