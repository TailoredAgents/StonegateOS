# Partner CRM requests and owner alerts

This release makes Requests the default Partners workspace. Needs attention, Waiting on client, and Handled combine service requests, schedule changes, cancellations, job changes, billing questions, and address reviews. Counts are permission filtered and shared by the queue, company cards, Partners navigation, and owner shortcut.

Request details retain the existing full submission, media, contact/access, requirements, and billing components. Confirmation reuses the guarded scheduling mutation. The displayed arrival window and final scheduling transaction share `partnerStaffArrivalWindow`; the preview is not a capacity reservation.

## Alert behavior

Owner configuration explicitly selects an active owner and their current CRM phone. No Sales assignment fallback is used. Evaluation events commit with ordinary/template/additional submissions; recurring uses the same submission path; completed bulk imports and final client approvals enqueue their own evaluations. These private staff texts never enter customer conversations. A request waiting for client approval before rollout becomes eligible when its final client approval happens after activation; existing work already ready before activation is not backfilled.

Alert groups have fixed identities and membership. Each booking can be claimed once for a given owner. Later approvals coalesce for 60 seconds; bulk retries only announce unclaimed successful requests. Provider-accepted initial sends start one 30-minute reminder. The existing staff delivery ledger handles uncertain provider results without blindly resending.

Actual owner openings are recorded independently of delivery, including an opening before a group exists. GETs, list views, another employee, hidden pages, incomplete group pages, and unsuccessful detail loads do not acknowledge alerts. An opening never schedules or approves work. Dispatch rechecks the selected owner, phone, permissions, settings, and actionable work.

SMS summaries contain company/requester, service/public work description, requested timing, public address, and an authenticated CRM link. Access instructions/codes, financial fields, and photo URLs are omitted. Password login, magic links, password setup, and recovery retain safe `/team` destinations; the destination still enforces authorization.

## Database and rollout

Migration 0175 is additive apart from extending the existing staff notification ledger checks. It defaults owner alerts off. A narrowly guarded repair moves previously fully approved, unscheduled `approval_needed` jobs into staff review, releases their obsolete active approval holds, and records a system job event. It does not enqueue historical texts or reserve appointments.

Roll out API/migration, then worker, then Site. Enable the selected owner only after the application rollout. `apps/api/scripts/configure-partner-owner-alerts.ts` defaults to read-only and verifies owner identity plus the approved phone suffix. Explicit execution records an audit; `--send-test` queues one generic TEST per release key without creating customer work. Replaying the same release key preserves the initial enable time and test operation.

The source commit uses `[skip render]` so deployment order is controlled manually after the exact commit passes the required Partner Portal production journey. Automatic deployment configuration remains unchanged.

## Validation

Local evidence before deployment:

- Required API unit lane: 126 passing suites/963 tests, with database-only cases skipped when no DATABASE_URL is provided.
- Website unit lane: 227 passing tests.
- Full PostgreSQL lane: 43 passing suites/237 tests; additional historical handoff regression and post-activation approval regressions subsequently added to the owner suite.
- Owner alert PostgreSQL suite: 14 passing cases, including simultaneous evaluation, immutable bulk groups/later approval waves, accepted-send timing, uncertain delivery, routing changes, pre-group openings, customer-approval handoff, and historical repair.
- Actual inbox component browser matrix:Chrome and WebKit at 1440px/375px, four passing journeys covering filters, permissions, detail recovery, owner/group acknowledgment, form preservation, keyboard focus, and arrival-preview gating.
- Auth action/callback harness:five passing tests; existing API/callback quartet: 27 passing tests.
- Private owner route/summary tests cover owner-only mutation, guarded reads, idempotency, safe summary fields, and direct request/group links.
- Audited setup CLI replay on isolated local records created one test operation, retained enabledSince/revision, and changed no appointment/booking counts.
- Worker import/render check: zero network attempts.

Production API and Site builds passed. The complete local empty-company activation/first-request journey passed at 1440px and 375px. The full CRM request handoff passed at both widths, including actual photos, normal anonymous-link password sign-in, seven initially collapsed detail groups, all submitted fields, arrival preview, Confirm service, and resulting database/calendar/mobile records.

Exact-commit CI, deployment IDs, live health, and the authorized TEST receipt are recorded below after rollout.
