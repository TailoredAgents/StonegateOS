# Critical Flows (Must Never Break)

These are the workflows we treat as production-critical. Any change that touches them requires extra verification.

## Public site
1. Call/SMS buttons
   - Call opens phone dialer with correct business number.
   - SMS opens correct channel (no personal dialers).

2. Booking
   - `/book` flow completes end-to-end.
   - Appointment appears on CRM calendar.
   - Confirmation SMS/email is correct (book/reschedule/cancel).

3. Lead intake
   - Any public lead forms write contacts/leads cleanly (no schema errors).

## Team console (`/team`)
1. Contacts
   - Create/edit contact without requiring address.
   - Assign to works and persists without refresh weirdness.

2. Unified Inbox
   - Inbound SMS appears in threads.
   - Inbound FB DM appears in threads (if configured).
   - Media is viewable.
   - AI Suggest returns a draft reliably.

3. Sales HQ
   - New lead appears when a new contact/lead is created.
   - Speed-to-lead rules respect business hours.
   - Press-1 call escalation connects (agent -> customer).
   - Follow-up cadence creates tasks and reminders as expected.

4. Outbound queue
   - Imported prospects do not pollute inbound Sales HQ.
   - Cadence starts only when first contact occurs.
   - “Answered” stops cadence (auto), and salesperson can set manual reminders.

## Ops / Owner
1. Job completion
   - Mark complete updates appointment status and revenue metrics.

2. Commissions
   - Percentage commissions calculate from the final job total.
   - Sales commission is retired; management follows the active dated policy.
   - Percentage crew labor is 20% for 1–2 people and 30% for 3 or more, split equally; all four receive 7.5% each.
   - Devon is selectable alongside Austin, Jeffrey, and Jed without changing account permissions. Moving labor stays hourly.
   - Saved historical compensation survives total-only corrections. Crew corrections refresh draft payroll and Spend; locked/paid periods require adjustments.
   - Weekly payout run can be generated and exported.

3. Partner portal (if enabled)
   - Partner login works (SMS/email).
   - Partner booking creates appointments in CRM calendar.

## Integrations + background jobs
1. Outbox worker
   - Drains outbox, sends notifications, runs scheduled agents.

2. Twilio
   - Inbound call routing works.
   - Outbound calls from CRM connect and show correct caller ID.
   - Recordings (if enabled) import and attach to the right contact.

3. Google Ads
   - Sync runs successfully.
   - Analyst report generates (manual mode) and stays approve-first.
