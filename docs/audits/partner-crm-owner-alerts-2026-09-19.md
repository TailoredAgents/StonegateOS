# Partner CRM requests and owner alerts

This release makes Requests the default Partners workspace. Needs attention, Waiting on client, and Handled combine service requests, schedule changes, cancellations, job changes, billing questions, and address reviews. Counts are permission filtered and shared by the queue, company cards, Partners navigation, and owner shortcut.

Request details retain the existing full submission, media, contact/access, requirements, and billing components. Confirmation reuses the guarded scheduling mutation. The displayed arrival window and final scheduling transaction share `partnerStaffArrivalWindow`; the preview is not a capacity reservation.

## Alert behavior

Owner configuration explicitly selects an active owner and their current CRM phone. No Sales assignment fallback is used. Evaluation events commit with ordinary/template/additional submissions; recurring uses the same submission path; completed bulk imports and final client approvals enqueue their own evaluations. These private staff texts never enter customer conversations. A request waiting for client approval before rollout becomes eligible when its final client approval happens after activation; existing work already ready before activation is not backfilled.

Alert groups have fixed identities and membership. Each booking can be claimed once for a given owner. Later approvals within a bulk import coalesce for 60 seconds; ordinary final approvals are queued immediately. Bulk retries only announce unclaimed successful requests. Provider-accepted initial sends start one 30-minute reminder. The existing staff delivery ledger handles uncertain provider results without blindly resending.

Actual owner openings are recorded independently of delivery, including an opening before a group exists. GETs, the ordinary request list, another employee, hidden pages, incomplete group pages, and unsuccessful detail loads do not acknowledge alerts. A complete, successfully rendered alert-group view intentionally records a group opening for the selected owner. An opening never schedules or approves work. Dispatch rechecks the selected owner, phone, permissions, settings, and actionable work.

SMS summaries contain company/requester, service/public work description, requested timing, public address, and an authenticated CRM link. Dedicated access instructions/codes, private notes, financial fields, and photo URLs are omitted. The public description is shortened and control characters are removed; it does not promise to detect secrets a client types into that public field. Password login, magic links, password setup, and recovery retain safe `/team` destinations; the destination still enforces authorization.

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

## Production verification and correction

The initial application commit, `e2bc38e668237cdb3bfdd2906142a6ce8588cc6a`, passed [required release run 35482011070](https://github.com/TailoredAgents/StonegateOS/actions/runs/35482011070). CI included 144 API suites/1,052 tests, 227 website tests, 41 compatibility tests, 43 PostgreSQL suites/239 tests, browser recovery, production builds, and both complete desktop/phone journeys.

The API, worker, and website deployed in that order. Migration 0175 is live. A read-only execution of the queue query with Jeffrey's actual permissions returned LandL's existing request as the sole Needs attention item, with service, address, requested timing, and confirmation permission present. No request opening or customer work was created by that check. The live queue, settings, detail, and opening endpoints all rejected unauthenticated requests with 401.

The approved settings were enabled for Jeffrey's existing phone ending 8806 at `2026-09-20T02:10:13.724Z`, revision 2. Exactly one generic TEST operation was queued: `6426c470-f8ac-4936-92bb-32fe00f0d9ca`. No historical alert group was created. Live verification caught a worker module-resolution failure before any provider attempt: lazy `@/lib/partner-owner-alerts` imports did not use the root worker's CommonJS alias resolver. Correction `7a721e5516983049e707ef1e35f405bcafd9ac35` uses a static relative import and verifies preparation, accepted-receipt finalization, the 30-minute reminder, and terminal replay through the production worker's actual loader with network access blocked. The new regression reproduced the failure before the correction. The existing queued TEST is retained for one delivery; no replacement operation is created.

The repository-wide [run 35482643934](https://github.com/TailoredAgents/StonegateOS/actions/runs/35482643934) passed application typecheck, the lint ratchet, and quote/expense PostgreSQL jobs. Its general API lane already had 129 failing suites/207 failure headings in baseline run 35296210354, mostly module-mode issues. Six additional source assertions were corrected in test files only: imported permission checks are now verified explicitly, and the password-setup assertion verifies the canonical helper and preserved destination. Focused checks passed 17/17; the broader related run passed 397 cases, with nine remaining manifest failure names exactly matching the baseline. This release does not claim a green repository-wide general API lane.

## Independent public-domain check

The local Xfinity network began returning a SafeBrowse warning redirect over HTTP and failing the custom domain's TLS handshake. IPv4, IPv6, apex, and www were affected; the Render hosting hostname remained reachable. No DNS, certificate, firewall, or ISP setting was changed.

An independent, read-only Render job, `job-dank31rm8hqs73bjb2l0`, succeeded at `2026-09-20T02:15:30Z`. With normal certificate validation enabled, the public health endpoint and sign-in page returned 200, and the public request link returned 307 to sign-in with its exact destination preserved. The Render hosting sign-in page also returned 200. This identifies a network-specific filtering problem rather than a public website outage. [Cloudflare's troubleshooting guidance](https://developers.cloudflare.com/ssl/troubleshooting/err-ssl-protocol-error/) describes ISP filtering, and [Xfinity's review process](https://www.xfinity.com/support/articles/report-blocked-website) is available for a mistaken block. No report or outside support message has been submitted.

## Rollback constraint

Keep migration 0175 forward. Before ever rolling the worker back to a version without owner-alert guards, pause both external sends and outbox dispatch and verify the effective settings. Disabling the owner-alert setting alone is insufficient for an old worker that does not understand generic owner notification subjects.

## Final rollout evidence

Correction `7a721e5516983049e707ef1e35f405bcafd9ac35` passed [required release run 35483752576](https://github.com/TailoredAgents/StonegateOS/actions/runs/35483752576), including 144 API suites/1,052 tests, 227 website tests, 41 compatibility tests, 43 PostgreSQL suites/239 tests, the production worker dispatch regression, browser recovery, production builds, and complete desktop/phone journeys. The worker regression used the actual root loader and made zero network attempts.

The final [general repository run 35484321181](https://github.com/TailoredAgents/StonegateOS/actions/runs/35484321181) passed typecheck, the lint ratchet, and quote/expense PostgreSQL jobs. Its remaining 129 failing suites/207 unique failure headings exactly match baseline run 35296210354; all six newly introduced stale assertion failures are gone. The required portal release gate is green; the unrelated general API lane remains red.

| Service | Live source | Deployment | Finished (UTC) |
| --- | --- | --- | --- |
| API | `7a721e5516983049e707ef1e35f405bcafd9ac35` | `dep-dankc7142hec73eplsgg` | 2026-09-20 02:38:55 |
| Worker | `7a721e5516983049e707ef1e35f405bcafd9ac35` | `dep-dankf06k1f9s7391kb4g` | 2026-09-20 02:41:35 |
| Site | `e2bc38e668237cdb3bfdd2906142a6ce8588cc6a` | `dep-danju1ajnfac738svorg` | 2026-09-20 02:07:53 |

The correction did not change website code or the database migration, so the website remains on its verified original deployment. API and worker were deployed in order after the correction passed its exact-commit release gate.

After verifying the corrected API and worker were live and allowing the old worker to drain, a guarded, audited operation made the original queued TEST eligible immediately instead of waiting for its earlier import-error backoff. It required the exact known test/event/recipient identity, zero provider attempts, no provider ID, and an unprocessed, non-quarantined event. It changed only the event's next-attempt time, retained error history, and created no replacement message or customer record.

The original TEST operation `6426c470-f8ac-4936-92bb-32fe00f0d9ca` succeeded at `2026-09-20T02:44:06.107Z` with exactly one provider attempt. Twilio accepted message `SM636d92e1eb13afcf96af2e68f255afee`; its subsequent receipt reported `sent`, no error code, and send time `2026-09-20T02:44:06Z`. This verifies sending, not handset delivery. No second test was sent. Jeffrey's settings remain enabled at revision 2 with the original activation time; the historical alert-group count remains zero.

At `2026-09-20T02:45:31Z`, both API and Site health and readiness endpoints returned 200. API readiness confirmed configuration, portal availability, database connectivity, migration 0175, worker health, and zero dispatchable outbox events. The read-only application queue check still returned LandL's existing request as the sole Needs attention item, with no opening, scheduling, or fabricated customer work.

Post-correction log review covered `2026-09-20T02:41:36Z` through `02:46:44Z`, including warning-level and error-level records plus explicit owner-notification/outbox error searches, with no remaining log pages. The only errors observed were five existing `audio_too_short` transcription failures, also present before this release; they are unrelated to partner requests. The earlier worker import errors occurred before the corrected deployment and did not reach the SMS provider. No new owner-alert or request-queue failure was observed after correction. At `02:46:45Z`, the test receipt still reported `sent` with one provider attempt and no error; handset receipt remains unconfirmed.
