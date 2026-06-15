# Ultimate ETA Agent Implementation Plan

This document is the build checklist for the ETA agent. The goal is to keep crew workflow simple while giving StonegateOS enough live operational state to draft accurate ETA updates for customers.

## Phase 0: Planning Document

- [x] Create `docs/ETA_AGENT_PLAN.md`.
- [x] Include implementation checklist, testing checklist, rollout steps, and assumptions.
- [ ] Keep this document updated as tasks are completed.

## Phase 1: Traccar GPS Foundation

- [x] Add database tables for crew tracking devices and location pings.
- [x] Add config support for `TRACCAR_BASE_URL`, `TRACCAR_API_TOKEN`, and `TRACCAR_LOCATION_FRESHNESS_MINUTES`.
- [x] Add backend Traccar sync that stores normalized crew/device positions.
- [ ] Configure Traccar server and first crew phone devices in production.

## Phase 2: Crew Job State

- [x] Add crew route/day state separate from `appointments.crew`.
- [x] Add appointment ETA events for explainability.
- [x] Connect route state to appointments, team members, contacts, and properties.

## Phase 3: Crew Controls In `/mobile`

- [x] Add compact ETA/status controls inside mobile job cards.
- [x] Keep the existing Maps button behavior.
- [x] Show saved status through redirect feedback.

## Phase 4: Matching Controls In `/team`

- [x] Add matching compact ETA/status controls to `/team` My Day cards.
- [x] Show current ETA state and pending draft state without adding a bulky crew screen.

## Phase 5: Crew Texting Through Business Line

- [x] Recognize crew phone numbers before normal customer inbox recording.
- [x] Parse simple crew SMS commands.
- [x] Ask for clarification when the text is ambiguous.
- [x] Prevent recognized crew texts from creating customer contacts or threads.

## Phase 6: ETA Engine

- [x] Use Traccar location, job schedule, customer address, dump status, and routing/fallback time.
- [x] Use Mapbox Directions when a token and coordinates are available.
- [x] Degrade to schedule/travel-buffer estimates when GPS or routing is unavailable.
- [x] Store confidence and GPS freshness with each draft.

## Phase 7: Customer ETA Drafts

- [x] Create draft-first customer update messages.
- [x] Prefer existing Facebook Messenger or SMS thread and create an SMS thread if needed.
- [x] Allow owner/admin send or dismiss.
- [ ] Add new Facebook Messenger thread creation only if Messenger customer identity rules allow it.

## Phase 8: Admin Review Surface

- [x] Add lightweight ETA draft review in `/team`.
- [x] Show customer, job, reason, suggested message, and send/dismiss actions.

## Phase 9: Smoothness And Safety

- [x] Keep crew workflow to Maps plus quick status buttons/text.
- [x] Avoid automatic customer sends.
- [x] Avoid confident language when GPS is stale or missing.
- [x] Log events so ETA decisions are explainable.

## Phase 10: Testing And QA

- [x] Add unit coverage for crew text parsing, ETA draft generation, and GPS freshness behavior.
- [x] Run full typecheck/build.
- [x] Run focused API/unit tests.
- [x] Run lint on touched API/site files.
- [ ] Manual QA `/team` My Day.
- [ ] Manual QA `/mobile` My Day and Calendar.
- [ ] Manual QA Traccar sync with a real configured device.

## Rollout Steps

- [ ] Deploy database migration.
- [ ] Configure Traccar server and API token.
- [ ] Install Traccar Client on one crew phone.
- [ ] Add the crew phone device ID mapping in `crew_tracking_devices`.
- [ ] Run in draft-only mode for one crew day.
- [ ] Review ETA drafts for accuracy before sending.
- [ ] Expand to remaining crew phones or truck trackers.

## Assumptions

- Traccar is the primary live GPS source.
- Crew phones are the first tracking device.
- Truck trackers can be added later through the same device mapping table.
- Google Maps remains the driver navigation app.
- StonegateOS does not read the live route inside Google Maps.
- Customer updates remain draft-first until proven reliable.
