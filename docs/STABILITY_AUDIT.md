# Stability Audit Checklist (Ads + Daily Ops)

Goal: prevent regressions while ads are live and the CRM is used daily. This checklist is optimized for Render deployments.

## How To Run (Render-first)
- Use `docs/RELEASE_CHECKLIST.md` for deploy steps.
- Run smoke checks from the API shell when possible: `pnpm -w smoke` (see `docs/RELEASE_CHECKLIST.md`).
- Watch Render logs while testing:
  - `stonegate-site` (site)
  - `stonegate-api` (API)
  - `stonegate-outbox-worker` (worker)

## A) Public Site / Ads (highest priority)
These flows must not break while ads are running.

1) Landing + performance
- Load `/` and `/book` on mobile and desktop.
- Confirm the page renders without hydration errors, blank sections, or infinite loading.

2) Tracking
- Meta Pixel: confirm `PageView` and `Schedule` (or equivalent) fires during booking flow.
- Google Ads tag: confirm the `Book appointment` conversion fires on successful booking (test in Google “Troubleshoot” / Tag Assistant).

3) Booking flow (/book)
- Complete a booking end-to-end using a fresh phone/email.
- Confirm:
  - confirmation SMS goes to the customer
  - lead alert SMS goes to the assigned salesperson (if enabled)
  - appointment appears in `/team?tab=calendar`

4) Quote intake flows
- `/quote` or any “get pricing” form should submit successfully with valid contact input.
- Confirm server-side validation errors are user-friendly when data is missing.

## B) Lead + Messaging (high priority)
1) Inbound SMS
- Text the Twilio business number.
- Confirm thread appears in `/team?tab=inbox` and routes to the correct contact or creates one.

2) Inbound Messenger
- Send a FB page message.
- Confirm thread appears in inbox with a stable sender identity (not “first message text”).

3) Outbox / reminders
- Create a reminder due in 2 minutes.
- Confirm worker sends SMS and the log shows `crm.reminder.sent`.

4) Autopilot safety checks
- Ensure draft mode does not send immediately.
- Ensure SMS escalation does not trigger on inbound SMS (only notify).

## C) Calling (Twilio)
1) Outbound “Call” button
- From a contact, click `Call`.
- Confirm it rings the configured rep and connects after pressing 1.

2) Inbound calls
- Call the business number from an unrecognized phone.
- Confirm it forwards and creates/updates a contact and a call record.

3) Call notes + coaching
- Confirm call notes appear under the contact.
- Confirm coaching appears in Sales HQ after worker processing.

## D) Team Console Core Tabs
- Contacts: create, edit, assign, add notes (no “saving forever”).
- Pipeline: move a contact; stage labels consistent; no infinite scrolling regressions.
- Calendar: month navigation works; booking from contact works; cancel/reschedule works.
- Inbox: threads ordered by last activity; no duplicate “No messages yet” threads.
- Outbound: imported prospects are filterable; dispositions persist; cadence starts only after first touch.

## E) Data Integrity / Schema
- Confirm `/api/admin/db/status` is `ok:true`.
- If anything 404s (missing tables/columns), run `pnpm -w db:migrate` on Render once and re-check.

## Stop-the-line Rules
If any of these happen, stop changes and rollback:
- `/book` cannot complete a booking.
- inbound SMS/FB messages do not show in inbox.
- lead routing calls hang up after “press 1”.
- inbox fails to load threads.
