# Autonomous Facebook Sales Integration Guide

## Goal

Build an autonomous Facebook Messenger sales closer for junk removal only. The system can qualify a customer, ask for missing details, create a quote range, offer appointment times, and book a job after the customer clearly confirms a shown time and price or price range.

Version 1 does not require a payment or deposit before booking. It starts in shadow mode, then can move to assist mode, then low-risk auto mode after review.

## Current Structure

- Facebook webhooks store inbound Messenger messages in the unified inbox.
- `message.received` outbox events run existing auto-reply and Sales Autopilot drafting.
- Quotes, instant quotes, media job analysis, availability assist, booking, public quote acceptance, reminders, and team automation controls already exist.
- The new autonomous closer is a separate orchestration layer so quoting and booking decisions are explicit, logged, and reversible.

## Implemented Backend Shape

- `apps/api/src/lib/facebook-sales-autopilot.ts` evaluates inbound Facebook DM messages.
- `facebook.sales.evaluate` outbox events run after inbound messages are stored.
- The orchestrator classifies the thread, stores a session, records every action, and either logs, drafts, sends, books, or creates human-review work depending on mode.
- Database tables:
  - `facebook_sales_autopilot_sessions`
  - `facebook_sales_autopilot_actions`
- Policy lives under `sales_autopilot.facebookCloser`.

## Modes

- `off`: no Facebook closer activity.
- `shadow`: decide and log only. No customer messages and no bookings.
- `assist`: create drafts/proposed actions for team approval.
- `auto`: execute only low-risk allowed actions.

Default mode is `shadow`.

## Safety Rules

Auto-book only when all are true:

- Channel is Facebook DM.
- Service is junk removal.
- Customer is in service area or has enough location data to confirm.
- Job looks standard and low-risk.
- Photos or enough job detail support a reliable quote.
- A price or range was shown to the customer.
- Appointment slots were shown to the customer.
- Customer clearly confirms a specific offered slot.
- Human takeover, paused automation, DNC, and emergency stop are all off.
- The Messenger response window is still safe.
- The selected slot is rechecked by the booking endpoint.

Force human review when any are true:

- Demolition, brush or land clearing, dumpster requests, hot tub, playset, shed, concrete, dirt, rock, hazardous material, whole-house cleanout, hoarding, or large commercial cleanout.
- Missing or uncertain address/location.
- Out-of-area or uncertain service area.
- Low-confidence quote analysis.
- Customer disputes the price.
- Customer asks for an unavailable time.
- Duplicate or ambiguous lead/contact data.
- Messenger send window appears expired and SMS fallback is not allowed.
- Provider/API failure.
- Confirmation cannot be confidently parsed.

## Quote Flow

1. Read the full contact, lead, property, thread, instant quote, and media context.
2. If media exists, reuse or create media job analysis.
3. Convert junk volume estimate into a quote range.
4. Store quote range on the autopilot session.
5. Send or draft a short Messenger summary:
   - estimated range
   - what it includes
   - final price may change if actual volume, weight, access, or materials differ
   - ask whether they want available times
6. If the customer asks for a formal quote, use existing quote records and public quote links.
7. If the quote is accepted in DM or on the public quote page, continue to booking.

## Booking Flow

1. Offer 2 or 3 available appointment windows.
2. Save those offered slots to the autopilot session.
3. Parse the customer reply for clear confirmation.
4. Re-check and book through the existing booking endpoint.
5. Create the booking with:
   - `source: facebook_autopilot`
   - appointment type `job`
   - service `junk_removal`
   - quoted range metadata
   - contact/thread/lead metadata
6. Send Facebook DM confirmation.
7. Existing booking notifications and reminders continue through the current booking system.
8. Mark the thread state as booked.
9. Record an audit event and action row.

## Messenger Policy Guardrails

- Track the last meaningful inbound DM timestamp.
- Keep v1 inside the configured Messenger response window.
- Do not send proactive Facebook follow-ups outside that safe window.
- If outside the window and SMS fallback is allowed with a phone number, hand off to SMS.
- If outside the window and no phone exists, create human review.
- Before production auto mode, verify behavior against current Meta docs:
  - https://developers.facebook.com/docs/messenger-platform/reference/send-api/
  - https://developers.facebook.com/docs/messenger-platform/send-messages/
  - https://developers.facebook.com/docs/messenger-platform/policy/

## Automation Settings

Team settings expose:

- Facebook autonomous closer mode: off, shadow, assist, auto.
- Allowed service type: junk removal.
- Max auto-book quote amount.
- Minimum confidence for auto-booking.
- Required customer confirmation.
- Require photos above threshold.
- DM-to-SMS fallback.
- Emergency stop.
- Messenger response-window hours.

Production defaults:

- mode: shadow
- service: junk removal only
- require clear confirmation: true
- require human review for non-standard jobs: true
- no payment required: true

## Team UI

Automation page:

- Facebook Sales Autopilot status card.
- Mode selector.
- Readiness checklist:
  - Facebook webhook configured
  - Messenger token configured
  - outbox worker running
  - OpenAI key configured
  - booking endpoint reachable
  - calendar configured
  - service-area policy configured
- Safety controls:
  - max auto-book price
  - require photos threshold
  - DM-to-SMS fallback
  - emergency stop
- Recent autonomous actions list with link to Inbox.

Inbox:

- Facebook autopilot stage badge on thread groups.
- Human review badge when needed.
- Details panel explaining mode, last decision, reason, and quote range.

Future Inbox improvements:

- One-click approve/reject for assist-mode proposed quote or booking.
- Dedicated “Needs human review” inbox filter.
- Timeline event card for auto-booked jobs.

## Customer-Facing UI

Public quote page:

- Mobile-first quote summary.
- Clear “No deposit required” terms.
- “Accept and pick a time” path.
- Confirmation and expired-quote states.
- Trust details:
  - licensed and insured
  - make-it-right guarantee
  - what is included
  - what can change final price

Future public quote improvements:

- Inline available slot picker after quote acceptance.
- Direct quote-to-booking token flow tied to the quote contact/property.

## Worker Flow

1. Facebook webhook queues inbound DM.
2. Inbox records the inbound message.
3. `message.received` runs existing inbound handlers.
4. Worker queues `facebook.sales.evaluate`.
5. Facebook sales evaluator creates a decision.
6. Shadow mode logs only.
7. Assist mode creates drafts/proposals.
8. Auto mode executes only low-risk allowed actions.
9. Outbound messages still send through the existing outbox `message.send` path.

Event types:

- `facebook.sales.evaluate`
- `facebook.sales.action.proposed`
- `facebook.sales.action.execute`
- `facebook.sales.human_review`
- `facebook.sales.shadow_decision`

## Implementation Checklist

- [x] Create this implementation guide.
- [x] Add autonomous Facebook sales policy fields and defaults.
- [x] Add database migration for sessions/actions.
- [x] Add Facebook sales orchestrator module.
- [x] Add quote-range action logic.
- [x] Add availability/time-offer action logic.
- [x] Add booking executor.
- [x] Add human-review task creation.
- [x] Add shadow-mode logging.
- [x] Add automation settings API fields.
- [x] Add Automation UI controls and readiness checklist.
- [x] Add Inbox UI status badges and decision details.
- [x] Add public quote UI copy improvements.
- [x] Add outbox event handling.
- [x] Add audit logging for decisions.
- [x] Add focused unit tests for confirmation parsing and quote mapping.
- [ ] Add formal quote-link executor from Messenger request.
- [ ] Add assist-mode approve/reject endpoint for proposed quote or booking.
- [ ] Add dedicated “Needs human review” Inbox filter.
- [ ] Add richer metrics dashboard for proposed, executed, blocked, failed, and human-review decisions.
- [ ] Add full E2E browser tests for Messenger DM to booked appointment.

## Test Plan

Unit tests:

- Parse clear booking confirmation.
- Reject vague confirmation.
- Map media volume into quote range.
- Block non-standard/risky language.
- Block low-confidence or out-of-policy jobs.
- Prevent sending outside the allowed Messenger window.

Integration tests:

- Facebook DM inbound creates contact/thread/message.
- Shadow mode logs but does not send/book.
- Assist mode proposes but does not execute.
- Auto mode sends safe messages only.
- Customer with photos gets a quote range.
- Customer asks for times and receives available slots.
- Customer confirms offered time and appointment is booked.
- Booking creates calendar/outbox notification events.
- Human takeover stops automation.
- New inbound message cancels stale proposal.
- Failed Facebook send retries or escalates.

E2E scenarios:

- Happy path: DM -> photos -> quote -> slots -> confirmation -> booked.
- Missing info: DM -> one question -> customer answers -> quote.
- Quote link: DM -> formal quote link -> customer accepts -> booking.
- Risk path: hot tub/demo/large job -> human review.
- Expired window: DM follow-up blocked -> SMS fallback or human review.
- Duplicate contact: possible duplicate -> human review.
- Slot race: chosen slot taken -> offer new slots.
- Worker restart: no duplicate messages or bookings.

## Rollout

1. Keep mode in `shadow` for at least one week of real Facebook traffic.
2. Review action logs daily.
3. Tune risky-job patterns, quote thresholds, and confidence requirements.
4. Move to `assist` for quote/time drafts.
5. Allow `auto` only for low-risk junk removal jobs under the configured price cap.
6. Keep emergency stop visible and tested.
