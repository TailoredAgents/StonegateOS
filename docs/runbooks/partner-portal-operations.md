# Partner Portal operations and incident runbook

- Owner: Stonegate operations and engineering
- Scope: authenticated Partner Portal V2, its public access/invitation/proof handoffs, and supporting staff workflows
- Default posture: preserve accepted records, stop unsafe writes or promises, and route uncertain work to staff review
- Last updated: 2026-09-04

## Authentication posture for the expand-only MFA runtime removal

MFA is removed from both Team and Partner runtime. Partners authenticate with
their password and a revocable server session. Team and Partner actions still
require the current session, identity/account/membership eligibility, and the
exact role, permission, capability, and scope assigned to the actor. Origin and
CSRF validation, revision checks, idempotency, security-version invalidation,
audit evidence, typed confirmations, and applicable recent-authentication
policy remain in force. Removing MFA does not relax any of those controls.

This is an expand-only runtime release. It removes MFA requirements, routes,
prompts, step-up gates, and authorization dependencies without a pre-deploy
cleanup or schema contract change. Historical method, recovery, enrollment, and
required/enrolled-flag records remain in place and inert so old and new
instances can coexist while the rolling deployment is in progress. No Team or
Partner authorization decision may grant or deny access from that retained MFA
state. Normal runtime safety may consume stale pre-session transactions or
login tokens and revoke retired legacy, magic-link, or step-up sessions when
they are presented or replaced by successful password login. Once password-only
activation is live or creates a user/session, the former mandatory-MFA
application is not a valid rollback target.

Do not add a destructive MFA cleanup to the pre-deploy migration phase. Render
may run that phase while the prior application release is still serving, so a
cleanup or write guard could break the live old release before traffic switches.
Cleanup, constraint changes, and schema removal belong in a separate contract
migration only after the runtime removal has been deployed, observed, and
explicitly verified and the rolling-deployment overlap has ended.

Legacy MFA data is not authentication or authorization evidence. Do not ask a
user to enroll an authenticator, supply a one-time or recovery code, or complete
an MFA step-up. Do not re-enable, disable, consume, or delete legacy MFA state
manually as part of this release; let the supported credential/session runtime
perform its scoped invalidation. This runbook records repository behavior only;
it does not claim that the runtime removal has been rehearsed or deployed in
production.

## Incident priorities

| Priority | Examples                                                                                             | Immediate objective                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P0       | Cross-account exposure, double booking, incorrect payment allocation, authentication bypass          | Stop affected reads/writes immediately, preserve evidence, and begin tenant/security response. |
| P1       | Calendar freshness failure, repeated hold conflicts, provider outage, inaccessible proof or invoices | Disable the unsafe feature while preserving review intake and existing records.                |
| P2       | Delayed notifications, isolated upload failures, degraded reports, individual access issue           | Contain the affected workflow, give an honest recovery path, and reconcile queued work.        |

Never delete V2 data as an incident response. Feature switches stop exposure or mutation; accepted bookings, payment evidence, documents, messages, and audit records remain intact.

## First-response checklist

1. Record the UTC start time, affected account/job identifiers, user-visible correlation ID, reporter, and current feature-switch state.
2. Determine whether the incident can expose another account, promise unavailable capacity, or misstate money. If yes, treat it as P0.
3. Preserve relevant API, worker, audit, outbox, calendar-sync, payment-attempt, and document-access evidence. Do not place addresses, access codes, payment tokens, or message contents in an incident chat.
4. Apply the narrowest safe switch below. If the failure mode is uncertain, stop V2 writes and instant confirmation while leaving read access available.
5. Confirm the user-facing fallback is truthful: a review request, retry, support handoff, or read-only state. Never show a booking as confirmed or an invoice as paid based only on a provider redirect.
6. Reproduce with a seeded Stonegate-owned internal account before restoring the
   affected feature. Production partner traffic is restored only through the
   globally controlled cutover; there is no selected-partner canary cohort.

## Rollout and rollback switches

| Switch                                                                       | Safe effect when disabled                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTNER_PORTAL_V2_READS_ENABLED`                                            | Removes V2 account data from service. Use only for exposure or unsafe serialization incidents.                                                                                                             |
| `PARTNER_PORTAL_V2_WRITES_ENABLED`                                           | Stops V2 mutations without deleting drafts, jobs, proof, invitations, or commercial records.                                                                                                               |
| `PARTNER_PORTAL_INTERNAL_TEST_MODE` / `PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS` | Staging/internal-test isolation only. The account list has no effect unless internal-test mode is explicitly enabled. Both must be disabled/empty at the external cutover so every partner moves together. |
| `PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED`                                | Keeps intake available but routes eligible requests to review instead of promising capacity.                                                                                                               |
| `PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED`                                     | Stops creation/refresh of Square-hosted invoice payment links; invoice and payment history remains read-only.                                                                                              |
| `PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED`                                   | Stops creation/completion of embedded card payment operations without disabling hosted invoice links.                                                                                                      |
| `PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED`                              | Stops portal email/SMS provider dispatch; in-app records and durable delivery-ledger/outbox evidence remain queued for controlled recovery.                                                                |
| `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED`                                | Stops the worker from claiming tentative recurring occurrences. Future occurrences remain explicitly tentative and no new hold or appointment is created by the evaluator.                                 |
| `PARTNER_RECURRING_HORIZON_BATCH_SIZE`                                       | Bounds one evaluator pass to 1–100 occurrences; default is 20. Lower this during a cautious canary or recovery.                                                                                            |
| `PARTNER_RECURRING_HORIZON_INTERVAL_MS`                                      | Controls evaluator cadence; default is 300,000 ms and values below 60,000 ms fall back to the safe default.                                                                                                |
| Provider/outbox kill switches                                                | Prevent worker dispatch before provider calls. Verify the worker service has the same values as the API service.                                                                                           |

Containment and forward-repair sequence for an unknown production defect:

1. Disable instant confirmation.
2. Disable V2 writes.
3. In staging, restrict access to Stonegate-owned internal accounts while the
   defect is reproduced. At production cutover, use global maintenance/read-only
   behavior instead of serving different authorization systems to different
   partner accounts.
4. Disable V2 reads only for a suspected tenant or serialization exposure.
5. Keep workers stopped for the affected provider until queued operations are inspected; do not discard queued rows.
6. Keep the password/session runtime deployed and ship a forward fix. Never
   restore the former mandatory-MFA application after password-only activation
   is live or has created a user/session.

Re-enable in reverse order after staging/internal-account validation and a
production smoke check with Stonegate-owned accounts. Partner traffic returns
globally only after the cutover gate is re-approved. Recovery is incomplete
until accepted bookings, holds, payments, and outbox rows created around the
incident have been reconciled. Authorization must never revert to the old
mandatory-MFA runtime, CRM contacts, or routine magic-link login.

## Privacy-safe portal telemetry

The authenticated and public partner shells emit only first-party product
events through the existing Stonegate analytics ingest. Portal paths are
normalized before transmission: job, proof-share, and other opaque URL
segments become placeholders, and query strings are removed. Product mode also
omits referrer, campaign, ZIP/location, and free-form form values. Interaction
events are accepted only from explicit static `data-partner-analytics` keys.

Use `partner_page_view`, `partner_action`, `partner_form_submit`, and portal-path
`web_vital` rows to monitor acquisition, booking, upload, reschedule, message,
and payment funnel health. Never add addresses, notes, contact values,
filenames, PO/cost-center data, billing amounts, payment tokens, job IDs, or
account/member IDs to the event key or metadata. LCP, INP, and CLS field values
are operational signals, not proof that the launch budgets pass; evaluate p75
after the global cutover has enough representative, privacy-safe traffic.

If an analytics payload is suspected of containing private data, disable the
client instrumentation in the portal shell, preserve the affected event IDs,
restrict access to the analytics tables, and follow the data-incident process.
Do not delete broadly until scope and retention obligations are confirmed.

## Calendar freshness and external busy coverage

Alert signals:

- Calendar synchronization or external-busy coverage is older than 15 minutes.
- Imported busy-block counts change unexpectedly or mirrored Stonegate events become external blocks.
- Availability is offered while the calendar state is `stale` or `unconfigured`.

Response:

1. Disable instant confirmation; do not remove previously imported `schedule_blocks`.
2. Check calendar credentials/configuration and the latest `calendar_sync_state` values for the configured calendar.
3. Inspect reconciliation errors and confirm Stonegate-mirrored appointment events are excluded.
4. Run synchronization against the staging/internal Stonegate calendar. Verify the coverage timestamp advances and a known busy event removes capacity.
5. Confirm stale dependencies still accept a clearly labeled review request rather than a confirmed slot.
6. Re-enable instant confirmation only after two successful sync cycles, an
   internal availability/hold/submit journey, and the global production gate.

## Account scheduling-policy containment

Each Partner account has one persisted scheduling policy managed from the
Companies view in `/team/partners`. It may require more notice, require more
local-calendar lead days, shorten the global Partner booking horizon, or
disable instant confirmation. It cannot add operating hours, capacity, or
override a stricter service, pricing, approval, calendar, routing, hazard, or
global feature gate.

If a policy row is missing, treat that as a configuration incident: instant
confirmation must remain disabled and requests must route to review. Do not
insert an ad hoc row or bypass the configuration review reason. Verify
migration `0147_partner_account_scheduling_policy` is applied, repair through a
reviewed migration/operational procedure, then save the intended account
limits through Team Partner administration. For an unexpected policy change,
preserve the policy revision and `partner_account.scheduling_policy_updated`
audit receipt, disable global instant confirmation if promises may be unsafe,
and reconcile availability, active holds, and submissions created around the
change. Policy updates share the scheduling advisory lock, so a successful
receipt must never coexist with a partially applied value set.

## Account cancellation and schedule-change policy

Each Partner account has one persisted cancellation policy managed from the
Companies view in `/team/partners`. Stonegate's launch baseline is at least 24
hours' notice, no automatic cancellation fee, and staff review for every late
confirmed-job request. Account configuration may require more notice or turn
off direct confirmed-job cancellation; it cannot shorten a stricter Stonegate
cutoff or enable direct action when the global rule disables it.

Cancellation and reschedule mutations load the current policy only after
acquiring the shared scheduling advisory lock. Before the effective cutoff, an
otherwise eligible request follows the normal direct path. At or after the
cutoff, cancellation keeps the job scheduled and records a review request
event/outbox outcome. A schedule-change request stores its requested
replacement window in `partner_reschedule_requests`, releases the temporary
replacement hold, and leaves the existing appointment and promised window
unchanged until staff review. Neither path applies a fee automatically.

If a policy row is missing or invalid, keep confirmed-job cancellation and
rescheduling in review. Verify migration
`0148_partner_account_cancellation_policy` is applied; do not create an ad hoc
fee, shorten the baseline, or bypass the review outcome. Preserve the account,
job, policy revision, request/event, hold, appointment, audit, notification,
and outbox evidence. For an unexpected policy change, use the
`partner_account.cancellation_policy_updated` audit receipt and reconcile all
requests that raced the update. A successful update and a schedule mutation
cannot observe a half-applied policy because both serialize on the same lock.

Before restoring direct action, verify with a Stonegate-owned account that:

1. A request before the cutoff follows the normal direct path.
2. A request exactly at the cutoff receives the explicit staff-review/no-fee
   outcome.
3. A late reschedule leaves the original appointment unchanged and persists
   exactly one pending replacement-window request.
4. Reusing an idempotency key replays the same outcome, while a stale
   `If-Match` cannot alter the job.

## Cancellation review queue and decision incidents

Cancellation reviews are managed from **Cancellation reviews** in
`/team/partners`. Pending authority comes only from
`partner_cancellation_requests`; booking hash columns are compatibility
evidence, not queue or authorization state. Migration
`0149_partner_cancellation_request_lifecycle` also quarantines pre-migration
hash/event evidence in `partner_cancellation_request_reconciliation_cases`.
Those cases are intentionally read-only: do not invent a Partner request or a
Staff decision to remove them from quarantine.

For each decision, verify the request is still `pending`, its revision matches
the UI receipt, and the job/appointment are in a cancelable state. Approval and
decline both take the global schedule lock. Approval cancels the appointment
and public job together and supersedes a pending reschedule. Decline keeps the
existing schedule and clears only the cancellation-pending marker. Either
decision increments the request revision exactly once, writes a public job
event, notifies the requesting Partner, queues the resolution outbox record,
and commits the Staff audit/idempotency receipt. The database rejects edits to
request evidence, rewrites of a resolved decision, and concurrent second
decisions.

If a decision fails or its notification is delayed:

1. Do not retry with a new decision until the request, job, appointment,
   public timeline, audit, and mutation receipt are reloaded by opaque IDs.
2. If the request is revision 2 and resolved, treat the decision as committed;
   never attempt to reverse it by updating the request row.
3. Reconcile `partner.cancellation_request.resolved` and any
   `partner.notification.dispatch` outbox rows. Do not change the job merely
   to make a notification match.
4. If the request remains pending, reuse the original idempotency key when its
   payload is identical; otherwise refresh and submit an intentional new Staff
   operation.
5. If job or appointment state changed before approval, leave the request
   pending/conflicted and escalate for operational reconciliation rather than
   forcing a cancellation outside the scheduling service.

## Billing request and refund-review incidents

Partner billing requests are managed from **Billing requests** in
`/team/partners`. The durable `partner_billing_dispute_requests` row is the
only lifecycle authority. A pending request is immutable evidence attached to
one account and invoice; it does not place a hold on money, alter the invoice,
or authorize a provider operation. Before reading its history or thread,
always re-run the canonical Partner invoice-access predicate for the selected
account and membership scope.

Only a Commercial Manager or Team Owner with the delegated billing-dispute
permission and a current Team session may record one of the terminal
classifications: information provided, adjustment required, refund review, or
declined. **Adjustment required** and **refund review** are handoffs, not
execution. Complete any later invoice correction or provider refund through
its separate controlled workflow and never infer completion from the request
state.

If creation or classification appears inconsistent:

1. Reload the request, invoice revision, account binding, conversation thread,
   Staff audit, and idempotency receipt before retrying.
2. If the request is terminal at revision 2, treat it as immutable. Reconcile
   notification/outbox delivery without rewriting the classification.
3. If it is pending, reuse an idempotency key only with the exact original
   body. A second open request for the invoice must remain blocked.
4. Confirm the invoice status, total, paid amount, balance, allocations, and
   provider identifiers are unchanged by the request transaction.
5. Keep free-form reasons and evidence out of notification/outbox payloads.
   They may appear only in the access-controlled request and its dedicated
   account-billing conversation. Never copy billing evidence into a job thread;
   a related job ID is request linkage only.
6. Confirm `partner.billing_dispute.requested` and
   `partner.billing_dispute.resolved` converged into the durable notification
   ledger. Email and verified opt-in SMS remain subject to kill switches and
   preferences; suppressed delivery is not permission to expose evidence in an
   operational thread.

## Job change-request and commercial-reference incidents

Partner job changes are managed from **Job change requests** in
`/team/partners`. Pending authority comes only from
`partner_job_change_requests`; the immutable request snapshot is evidence, not
permission to change price or schedule. Staff may approve only proposed public
description, crew-instruction, access-detail, and on-site-contact fields after
confirming the current public-field snapshot still matches. If the request or
Staff review identifies any price, schedule, service, quantity, hazard, proof,
or other material impact, choose **Require change order** and select the exact
issued fixed-price Quote V2 for that account and job. Offering the change order
leaves the current job unchanged. Partner acceptance finalizes only the quoted
amount/currency and validated public scope fields; any schedule, service, or
proof effects remain visibly pending until Staff performs them through their
canonical operational workflows.

Approval, decline, and change-order routing require the current request
revision, a fresh idempotency key, the delegated Staff permission and current
Team session, a bounded operational reason, and the exact typed confirmation
shown in the UI. A successful outcome
increments the request revision exactly once, increments the job revision,
writes a public timeline event, creates an in-app Partner notification and
outbox record, and commits the Staff audit/idempotency receipt. The database
rejects request-evidence edits, a second pending request for the same
account/job, cross-account job/member combinations, and any attempt to rewrite
a resolved outcome.

Cancellation must never leave a pending change request actionable. Direct
Partner cancellation resolves it as immutable `superseded` with system and
triggering-membership evidence; Staff-approved cancellation uses the same
outcome with the resolving Staff actor. Both paths take the global schedule
lock before the account/job lock, cancel the job, resolve the pending request,
and write the public event/notification/outbox in one transaction. If a
cancellation races a Staff change decision, reload the canonical request: its
single terminal revision is authoritative. A same-key Partner replay must
return that stored state/resolution and the current job `ETag`, never a
synthetic pending response. A terminal job with an older pending request may
still be declined or routed to change-order review, but its changes must never
be approved or applied.

Direct commercial-reference editing is a different Partner action. Only an
Administrator or Billing/Approver with `commercial.edit` and a current eligible
Partner session may update the PO number, cost center, or project reference.
Operations users must not be granted this path. The mutation uses
the current strong job `ETag`, an idempotency key, and the same account/job
lock; it cannot change job scope, price, invoice data, schedule, service, or
proof.

Before enabling an account to book, configure its **Service agreement** in
`/team/partners`. Confirm the agreement is active, currently effective, uses
one ISO currency, and lists each intended service once with a deliberate
pricing state. Only `contracted` service/rate evidence can support instant
confirmation. `estimate`, `quote_required`, `standard_rate`, missing rates,
expired terms, and currency discrepancies must remain review-only. The Partner
booking, job receipt, and billing views disclose the agreement label,
effective period, inclusions/exclusions, quote rule, final-price basis, and the
verified account notification destination; they must never infer entitlement
from the global service catalog or a CRM contact.

For a failed or disputed operation:

1. Reload the opaque job and request from their account-scoped APIs. Do not use
   a raw appointment or CRM-contact ID to locate or authorize the record.
2. If a request is revision 2 and resolved, treat its outcome as immutable.
   Reconcile the public job event, Partner notification, outbox record, Staff
   audit, and idempotency receipt instead of issuing another decision.
3. If approval reports stale public fields, do not force-apply the old
   snapshot. Decline it or route it to change-order review after operational
   confirmation.
4. For a reference-edit `412`, refresh the job and compare the current PO, cost
   center, and project reference before intentionally submitting a new update.
   Never reuse an idempotency key with a different body.
5. If `partner.job_change_request.requested`,
   `partner.job_change_request.resolved`, or
   `partner.job_references.updated` remains unprocessed, preserve the canonical
   row/event/audit evidence and reconcile the outbox. Do not mutate the job
   just to make a delivery record match.
6. A malformed stored snapshot or account mismatch is a containment incident.
   Disable the affected action if needed and escalate for schema/tenant review;
   do not repair immutable evidence with direct SQL.

## Job-hub ETA, team, delivery-history, and issue incidents

The Partner job hub is a sanitized operational view. Its promised two-hour
arrival window remains authoritative. It may show an ETA only after Staff has
published/sent it, the estimate spans four hours or less, publication is no
more than 24 hours old (with five minutes of clock-skew tolerance), the start
is no more than 24 hours ahead, and the end has not passed by more than 15
minutes. The hub identifies the assigned team generically as a Stonegate
service crew and may show a safe crew count/state, but never names, resource
IDs, GPS, route detail, or internal assignment snapshots. Delivery history is
limited to the current account, job, and membership and exposes only the event,
safe delivery state, channel, and timestamp—not an endpoint, provider payload,
dedupe key, or failure body.

Partners report an issue through the same account/job-bound portal-visible
thread used by the Staff Inbox. Category and priority are allowlisted, the
body is bounded, attachments retain explicit account/job ownership, and the
send is idempotent. Staff-only messages remain excluded at query time. The UI
states that emergencies must use 911 or the appropriate emergency service;
the Portal must never imply emergency monitoring.

When the hub disagrees with operations:

1. Compare the promised window, published ETA, public event, notification
   delivery, conversation thread, and current job revision using the Support
   reference. Do not expose or copy internal dispatch/GPS data into the reply.
2. A draft, dismissed, unsent, structurally invalid, expired, too-old, or
   too-distant ETA must be absent. If a sent ETA nevertheless disagrees with
   operations, stop publishing further estimates, reconcile the Staff ETA
   source, and make any schedule correction through the canonical reschedule
   workflow; do not edit the promised window in place.
3. Confirm the issue has exactly one idempotent partner message in the one
   portal-visible job thread and appears in the Staff Inbox. Ambiguous inbound
   replies go to reconciliation; never attach them by shared contact alone.
4. For a failed notification, reconcile the account/member/job-scoped delivery
   row and outbox receipt. Never reveal the destination or provider failure to
   another account member who is outside its membership scope.
5. Preserve the public timeline/audit record and disable the affected
   projection if account binding or sanitization cannot be proven.

## Partner Quote V2 incidents

Quote V2 is the sole commercial lifecycle authority. The Partner-facing
`partner_quotes` row is only an immutable account/target binding and read
projection. Never repair a Partner decision by editing either projection or a
`quote_responses` row, and never make a `legacy_snapshot` actionable in place.

Staff should start a Partner quote from **Commercial** in `/team/partners`,
select the exact active account location/contact tuple, and follow its
account-bound link into the Quote V2 builder. A partial or manually edited
`partnerAccountId`/target query is expected to fail closed. Confirm the builder
banner names the intended company and location before creating the draft.

Partners find canonical and historical quotes under **Billing & documents**.
Canonical details show structured scope, pricing, terms, version history, and
the verified proposal PDF. Historical snapshots are visible but say that
Stonegate reconciliation is required and expose no accept/decline controls.

For a missing, stale, or disputed quote:

1. Resolve the opaque Partner quote ID inside the selected account. Reconcile
   its `partner_quotes` target with `quotes.partner_account_id`, the current and
   published Quote V2 version, and the account-owned booking/draft/location.
   Do not authorize from a CRM contact or expose the raw Quote V2 ID.
2. If acceptance is disabled, check that the current version is issued and
   unexpired, no open change request exists, the stored proposal PDF size and
   SHA-256 match, and any account approval covers the same target, currency,
   and exact selected amount. Do not bypass an approval by changing a role or
   by reusing an older request after price changed.
3. A `412` means the Partner must refresh and review the current version. A
   `409 quote_conflict` means another public, Staff, or Partner terminal actor
   won. Reload the aggregate, version, response, opportunity, activity event,
   outbox event, and audit evidence before communicating an outcome.
4. For an identical timed-out retry, reuse the original idempotency key and
   body. The response must return the same immutable response ID, post-state,
   and terminal `ETag`. Never reuse that key with different signer, options,
   consent, category, or notes.
5. A foreign-account response/binding rejection is a tenant-containment
   signal. Preserve the database error and correlation ID, disable Partner
   quote responses if necessary, and investigate the account/target creation
   path. Do not remove the composite foreign key or update immutable evidence.
6. If PDF storage is unavailable or the digest fails, leave acceptance
   disabled and restore/reconcile the canonical generated document. Decline
   may remain available because it does not claim agreement to missing
   proposal evidence.

Release evidence includes the source/route suite plus the opt-in PostgreSQL
account-corruption and public/Staff/Partner terminal-contention suites. The
contention suite must show one terminal winner, one response/outbox record,
and deterministic safe conflicts for the other actors.

## Recurring horizon evaluation

The outbox worker evaluates only active-series occurrences that have entered the account-local 30-day booking horizon. Anything later remains `tentative`; it has no hold, appointment, or reserved capacity. Each due occurrence is claimed with a bounded lease and evaluated through the same availability, hold, and booking-submission services as an interactive portal request. Review and failure outcomes create an account-scoped staff task when the account has its required portal contact anchor.

Safe enablement:

1. In staging, confirm `PARTNER_PORTAL_V2_READS_ENABLED` and
   `PARTNER_PORTAL_V2_WRITES_ENABLED` are enabled only for seeded
   Stonegate-owned accounts. Before the one external cutover, verify
   `PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS` is empty and the global preflight gate
   has passed.
2. Start with `PARTNER_RECURRING_HORIZON_BATCH_SIZE=1` and the default `PARTNER_RECURRING_HORIZON_INTERVAL_MS=300000`.
3. Set `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED=1` on `stonegate-outbox-worker` only.
4. Verify one internal occurrence transitions from `tentative` through evaluation to `confirmed`, `review`, or `failed`; confirm a review/failed occurrence has a matching open CRM task and that no occurrence beyond day 30 changed.
5. Reconcile the booking draft, opaque partner job ID, promised two-hour arrival window, hold disposition, appointment capacity, audit event, and any calendar outbox event before increasing the batch size.

If confirmations, capacity, or tenant scope are uncertain, disable `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED` first, then disable instant confirmation. A pass already in progress may finish its claimed occurrence atomically; wait for that pass to settle and reconcile it. Do not delete tentative occurrences or manually create replacement appointments. Stale `evaluating` leases are reclaimed idempotently after 15 minutes when the evaluator is safely re-enabled.

Partner lifecycle controls use `PATCH
/api/portal/v2/recurring-series/[seriesId]`. Pause and cancel stop only future,
unbooked tentative evaluation; they never cancel a job or remove a draft that
already exists. Resume restores only future rows previously skipped with
`series_paused` to `tentative`; the worker evaluates them only after they are
inside the 30-day horizon. A resume response is not a capacity promise.

For a pause/resume/cancel incident:

1. Stop the horizon evaluator if a row appears stuck in `evaluating`. The
   lifecycle endpoint returns retryable `409` instead of racing that claim.
2. Reconcile the series revision/state, every occurrence state/failure code,
   booking-draft and partner-job foreign keys, latest lifecycle audit, and
   terminal idempotency receipt. Never "repair" the series by changing an
   existing appointment.
3. Confirm the audit and receipt carry the same canonical request hash and
   post-state, and that a retry returns the stored result. A reused key with a
   different action, reason, account, or series must return `409`.
4. If the operation committed but the UI timed out, use the series `GET` and
   audit evidence before retrying. Preserve its latest strong `ETag`; a stale
   new operation must return `412`.
5. Before re-enabling evaluation, verify no future job/draft-backed row was
   changed, canceled future tentative rows remain visibly canceled, paused
   rows remain visible, and resumed outside-horizon rows have no hold or
   appointment.

## Service catalog and add-on pricing

Migration `0127_partner_service_add_ons.sql` seeds the canonical junk-removal add-ons and maps the existing staff rate tiers to them: `mattress_fee` → `mattress_disposal`, `paint_fee` → `paint_can_disposal`, and `tire_fee` → `tire_disposal`. The Team partner-rate editor starts new configurations at **$30 per mattress** and **$10 per paint can or tire**. These are editable starting defaults, not a promise for every account; saving the complete negotiated rate card is the supported workflow that binds it to the portal account and dual-writes canonical per-unit add-on prices.

The seeded junk-removal scheduling profile is deliberately review-only: `instant_confirmation_enabled` is false and pricing eligibility carries `reviewRequired`. Existing fee rows are backfilled where possible, but a missing account-bound rate card, missing add-on price, excessive add-on quantity, or disclosed restricted/non-standard scope must remain a review request.

Safe enablement:

1. Apply the migration to a fresh database and staging. Verify the internal
   account has one effective base-rate card plus the expected canonical add-on
   rows; never copy prices between accounts.
2. With instant confirmation disabled, compare the catalog as an approved
   `bookings.pricing.read` member and an applicant. The member may see only the
   negotiated amounts their role requires; the applicant has no account API
   access and may submit only the verification-first application.
3. Submit internal-account drafts with no add-ons and with each add-on at
   multiple quantities. Confirm the API—not the browser—calculates base, unit,
   line, add-on, and total amounts and persists the selected tier and immutable
   add-on snapshot on the job.
4. Tamper with a tier, add-on key, duplicate selection, quantity, account, or client-supplied price. The mutation must fail safely or route to review without changing another account's data or accepting the supplied amount.
5. Verify high quantities and the `restrictedItems`/`nonStandard` disclosures produce review reasons while preserving the request. Do not remove these review gates merely to make a slot confirmable.
6. Enable the service profile for instant confirmation only after duration,
   travel buffer, capacity pool, service territory, effective pricing, and
   current calendar coverage are approved. Exercise it with Stonegate-owned
   accounts in staging, reconcile the appointment quoted total, booking
   snapshots, public job DTO, audit, and calendar outbox state, then enable the
   global instant-confirmation switch at the one external cutover.

## Holds, capacity, and schedule mismatch

Alert signals:

- Duplicate active holds for the same operation, peak capacity above a pool limit, schedule/advisory-lock errors, or a job promise differing from its account booking record.

Response:

1. Disable instant confirmation. Disable V2 writes if actual double booking or cross-channel serialization is uncertain.
2. Preserve the conflicting appointment, hold, policy revision, resource-pool, schedule-block, idempotency, audit, and outbox rows.
3. Identify the canonical global schedule-lock transaction that wrote each row. Do not manually move one job before both customer promises are reviewed.
4. Expire only genuinely expired active holds through the normal release path. Never release a hold already consumed by a booking.
5. Run the Partner Portal scheduling/concurrency release lane against a fresh PostgreSQL database.
6. Staff must contact affected partners before any promised-window correction.
   Reopen instant confirmation only after a production-equivalent race test,
   internal Stonegate booking pass, and global go/no-go approval.

### Canonical schedule-writer inventory

The 2026-09-01 source audit classifies every production Drizzle writer of
`appointments`, `appointment_holds`, or `schedule_blocks`. The exhaustive guard
is `apps/api/src/__tests__/schedule-writer-inventory.test.ts`; adding a new
writer without classifying it fails the Partner Portal lane.

| Surface                           | Capacity-changing operations                                                                                             | Required boundary                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partner scheduling                | Draft changes that invalidate a hold; create/replace/release hold; instant or review submit; replacement-hold reschedule | `partner-portal-v2-scheduling/service.ts` acquires `acquireScheduleConflictLock(tx)` before the first draft/hold/appointment row lock or capacity read. |
| Partner approval and cancellation | Approval-hold release/consume, approval confirmation/decline, and job cancellation                                       | `partner-portal-v2-approvals.ts` and the portal cancellation route use the same advisory lock inside the mutation transaction.                          |
| Public quote booking              | Legacy quote hold/book, Quote V2 hold/book, and junk-quote hold/book                                                     | Both scheduling services and both junk-quote routes lock before conflict inspection, hold transition, or appointment creation.                          |
| Lead and staff booking            | Public lead-intake appointment creation, staff booking, estimate-to-job conversion, public/staff reschedule              | Each route locks before inspecting capacity and before inserting or changing the schedule.                                                              |
| Staff status                      | Transitions into or out of `canceled`, `completed`, or `no_show`                                                         | The canonical status route locks before the appointment row so a concurrent capacity claim re-reads the committed status.                               |
| Calendar reconciliation           | Mirrored appointment schedule/status changes and durable external busy-block reconciliation                              | `syncGoogleCalendar` performs both under one locked transaction with the coverage watermark.                                                            |
| Quote lifecycle                   | Voiding a Quote V2 record releases its active hold                                                                       | `voidQuoteV2` takes the schedule lock before quote and hold row locks.                                                                                  |

The only unlocked appointment-status automation is the inbound auto-reply
transition between `requested` and `confirmed`; both states consume identical
capacity and the source guard rejects adding a non-blocking state to that
path. Appointment writes in media, payment, notes, totals, seller attribution,
contact merge, and calendar-provider bookkeeping change only metadata or
optimistic versions. The legacy quote cleanup changes only already-expired
holds (`expires_at <= now`). None of those exemptions may change start time,
duration, buffer, pool/units, promised window, active hold status, schedule
block occupancy, or blocking/non-blocking appointment state without moving to
the shared locked transaction.

## Named resources and scheduling assistance

Instant confirmation depends on an eligible named resource assignment, not
only an aggregate capacity number. Crews, trucks, and equipment carry a
resource type, pool, active state, skills, and weighted capacity. The scheduler
derives the compatibility daily-job multiplier, while effective policy
supplies the maximum jobs per crew. It chooses one feasible combination under
the global schedule lock and copies its requirement and point-in-time
assignment snapshot onto the hold. Booking revalidates the live resources and
copies the assignment snapshot to the job; the snapshot is revision-audited
and is intentionally replaced on a valid reschedule. A missing, inactive,
unskilled, or over-limit assignment routes the request to review instead of
promising a window.

When a selected window fills or no candidate can be safely assigned, the
Partner UI may show ranked alternatives and accept exactly one explicit
scheduling-assistance preference: waitlist, callback, or no follow-up. These
are suggestions only. They never create a hold, crew assignment, appointment
start, calendar event, or promised window. The review job and its public
timeline/appointment note retain the preferred windows and assistance choice.

For a resource or assistance incident:

1. Disable instant confirmation if the resource roster, skill mapping,
   per-crew count, or persisted assignment snapshot disagrees with the job.
2. Preserve the hold, job, resource requirement/assignment snapshot, policy,
   public event, and correlation ID. Never replace resource IDs in a consumed
   snapshot.
3. Run the named-resource unit and PostgreSQL scheduling concurrency suites.
   Confirm each candidate satisfies skills, weighted pool capacity, active
   interval, and per-crew daily limits inside the lock.
4. Reconcile one review job and at most one durable assistance request with the
   same preferred windows. Same-key replay must not create another callback or
   waitlist entry.
5. Staff may confirm a preference only through the canonical hold and booking
   transaction. Contact the Partner before changing a requested window; never
   treat its rank as consent or capacity.

## Approval holds and review-only requests

Account approval is resolved from the current server-side rule set; a browser field or saved draft flag can never require, bypass, or satisfy approval. A qualifying request keeps one candidate as a 30-minute approval hold, remains visibly unconfirmed, and cannot be approved by its requester. Approval consumes a still-valid hold atomically with the appointment, public job, audit entry, and calendar outbox event. If the hold is missing or expired, the immutable decision remains approved but the job becomes `approved_needs_reschedule`; no schedule promise is manufactured.

Requests caused by missing slots, uncertain scope, stale calendar coverage, missing routing/geocoding, unconfigured service/pricing, or operational review are different: they retain one to three preferred dates only and reserve no capacity. Their appointment has no internal start or promised arrival window until staff safely schedules it.

When approval or review state disagrees:

1. Disable instant confirmation, preserve the draft, approval request/decision, hold, job, appointment, audit, and outbox rows, and do not recreate a decision.
2. Verify the requester and decision maker are different active memberships in the same account and that the decision maker has the current `approvals.decide` capability and eligible session.
3. Compare the captured rule snapshot with the version that applied at submission. Later rule edits must not rewrite it.
4. For a valid approval hold, reconcile one consumed hold, one scheduled appointment, one confirmed partner job, and one calendar-sync request with reason `partner.portal.v2.booking.approval_confirmed`.
5. For an expired approval hold, verify the appointment remains unscheduled and route the approved request through the normal reschedule/availability workflow.
6. For review-only intake, verify no active/consumed hold, internal appointment start, promised window, or capacity claim exists. Staff may schedule only through the canonical scheduler.

## Partner session security and containment

The canonical Team workspace at `/team/partners?p_admin=security` lists
Partner sessions independently from global identities and account
memberships. Use its explicit `Active`, `Expired`, or `Revoked` filter before
taking action. The directory deliberately excludes bearer/session hashes, IP
addresses, raw user-agent strings, and security-version internals.

To contain one lost or untrusted device:

1. Verify the person, selected company, membership, device label, last-active
   time, and expiry in the Security view.
2. Confirm the current Team session and delegated session-revocation
   permission, record a specific reason, type `REVOKE PARTNER SESSION`, and
   submit once.
3. Confirm the response and audit receipt describe
   `scope=single_partner_session`, with both identity and membership state
   unchanged. Confirm that session moves to `Revoked` and cannot call a Portal
   V2 endpoint.
4. If the request returns `412`, refresh the directory and reassess the newer
   session activity before submitting a fresh idempotency key. Do not bypass
   revision protection.

Use Memberships—not session revocation—to remove a person's access to one
company. Global identity disable is a separate Team Owner-only containment
action affecting every company, and must never be substituted merely because
one account or device is in question.

### Team Owner global identity containment

Use `Review global identity security` from the People or Security directory.
Do not proceed unless the owner panel lists the complete membership set and
the person, email, identity status, active-session count, and every company,
role, and membership status agree with the incident scope. More than 250
memberships fails closed and requires an offline owner review.

To disable the identity globally:

1. Decide that every company really must lose this person's sign-in access. If
   only one company is affected, suspend that membership instead.
2. Confirm the current Team Owner session, enter a specific 20–1000 character
   reason, and type `DISABLE [displayed email]` exactly.
3. Submit once. The API binds `If-Match`, the membership snapshot, actor, route,
   target, and payload to the idempotency receipt under one transaction.
4. Confirm the identity is `disabled`, its security version increased, and all
   sessions and pending credentials were revoked. Confirm the audit says
   `scope=global_partner_identity`, `membershipsChanged=false`, and
   `accountJobFinancialRecordsPreserved=true`.
5. Verify memberships, jobs, documents, invoices, payments, and account records
   still exist. Global disable is containment, not tenant cleanup or deletion.

Never use global disable to release a quarantined identity or repair tenant
binding. A stale identity revision or membership snapshot returns `412`; reload
and review every company again rather than resubmitting the old evidence.

### Retired MFA runtime and deferred data cleanup

The former Team Owner MFA-reset workflow and its routes are retired. Do not use
legacy MFA records to recover an identity, and do not create a replacement
authenticator or recovery-code enrollment. Normal password recovery remains
purpose-bound and must not automatically sign the user in.

Use this release procedure:

1. Confirm the deployment contains no MFA cleanup, contract migration, database
   trigger, or destructive backfill. Inventory legacy state only if needed for
   later planning; record counts, never secrets, and do not mutate it.
2. Rehearse the new runtime against a representative non-production database
   that still contains legacy MFA rows and flags. Verify password login,
   activation, Partner scheduling and commercial actions, and Team CRM actions
   depend on the current session and exact permissions but never request MFA.
3. Exercise old-release/new-release overlap in staging before traffic switches.
   The prior release must remain able to read the untouched schema while it is
   still serving, and the new release must ignore retained MFA data for
   authorization. Separately rehearse flags/maintenance/read-only containment
   and a forward fix; do not treat the old runtime as the rollback target after
   password-only activation begins.
4. Verify suspended/removed membership denial, cross-account `404`, session
   revocation, password reset, final Administrator protection, and Team
   permission denial still fail closed without an MFA branch.
5. If an identity or membership is stranded in a former activation handoff,
   leave it contained for explicit account-access reconciliation through the
   supported password activation and Staff administration paths. Do not repair
   it by changing MFA, identity, membership, transaction, or session fields in
   SQL during this expand release.
6. After the runtime removal is deployed and its production behavior and
   containment/forward-fix posture are explicitly verified, open a separate
   reviewed contract change for any legacy-data cleanup. Rehearse that later
   migration against a production-sized snapshot before scheduling it.

The presence of enabled methods, recovery rows, challenges, required flags,
historical AAL2 sessions, or former activation transactions is expected
compatibility state during this phase, not evidence that MFA remains active. It
becomes a cleanup input only for the later contract change. A runtime path that
consults that state to grant, block, or elevate access is an incident.

## Partner quarantine and provider reconciliation

`/team/partners?p_admin=quarantine` is the canonical read inventory for three
existing case types:

- globally quarantined Partner identities;
- migrated account memberships quarantined during privilege review; and
- legacy invitation/access-link delivery operations that were quarantined,
  require provider reconciliation, or have a recorded resolution.

The first two case types are read-only. Their current tables do not contain a
reversible release receipt, and the workspace must not guess email ownership,
tenant binding, role, scope, or migration approval. Use the displayed reason
and history to investigate, then follow an explicitly approved recovery or
migration workflow outside this queue. Do not edit a status directly.

An unresolved legacy provider-delivery case has one schema-backed resolution
path. A Team Owner may use it only with the dedicated permission, a current
Team session, and a direct provider review:

1. Compare every requested channel with provider delivery/search/support
   records. Preserve the provider evidence outside Stonegate before deciding.
2. If sent, enter the matching provider operation ID and choose delivery or
   support evidence. If not sent, leave provider IDs empty and use a provider
   non-send search or support response.
3. Record a specific 20–1000 character evidence summary and type the exact
   outcome confirmation.
4. Confirm the audit receipt says `providerCalled=false`,
   `automaticRedispatchAttempted=false`, and preserves the original provider
   outcome. The case should move to `Resolved` without creating another send.
5. If the operation changed or another owner resolved it first, refresh and
   reassess. Never bypass `If-Match` or reuse evidence from another case.

A confirmed non-send invalidates unused legacy access-link tokens. Resolution
does not create an identity, account, membership, CRM contact, invitation, or
new delivery. Provider ambiguity in the newer Partner notification ledger is
handled by its own reconciliation process and is not silently released here.

## Tenant scope and downstream CRM projections

An active `partner_account_membership` on a portal-enabled account is the only authorization source for V2. A CRM contact association, legacy portal profile, stale cookie, or client-supplied account/location identifier must never grant V2 access. Scoped memberships are evaluated against current portal location/property grants on every job, draft-media, thread, notification, proof, document, repeat-work, and schedule operation; tenant-invalid and same-account out-of-scope resources return the same `404` shape.

Appointments and legacy staff tools may still require a CRM contact/property projection. For an account-native portal tenant without one, booking submission creates a non-login operational contact projection under the locked account transaction, records `partner.portal.v2.operational_contact_projected`, associates the canonical physical property, CAS-updates only that account's location row, and rebinds any active hold for that same account/draft to the projected property before an approval request is created. That projection is downstream compatibility data—not the tenant boundary or an alternative principal.

For a suspected scope regression:

1. Disable V2 reads and writes for the affected cohort and preserve correlation IDs, session/membership revisions, account/location/job identifiers, and audit evidence.
2. Recheck current account access, membership state, access level, capability, and normalized scope. Do not restore access from a contact record.
3. Verify every cursor was minted for the same account, member, filter, and current authorization-scope hash.
4. Confirm draft media belongs to an authorized located draft or to the scoped creator of a locationless draft; never infer ownership from a shared contact.
5. After a scope change, verify prior job-linked notifications and attachments outside the new scope disappear while account-only notices remain.
6. Exercise cross-account, same-account out-of-scope, nonexistent, suspended-member, disabled-account, and stale-contact substitutions before reopening the canary.

## Partner account-profile settings

Personal display-name changes use `/api/portal/v2/personal-profile`. This is a
global identity attribute shown in Partner activity, not an account role or CRM
projection. The endpoint still requires a selected active account membership;
the mutation revalidates that exact binding under lock, enforces the current
strong `If-Match`, and commits the identity update and audit receipt together.
Never repair a failed update by writing a linked CRM contact or bypassing a
suspended membership. For an incident, preserve the correlation ID,
identity/account/membership IDs, response status, ETag, and audit receipt—but do
not copy the display name into analytics or incident metadata.

`/partners/settings` reads and updates organization, primary service contact,
billing contact/address, and default PO/cost-center guidance through
`/api/portal/v2/account-profile`. The record belongs to the selected
`partner_account`; do not reconstruct, overwrite, or authorize it from a CRM
contact. Organization/service-contact edits require account-wide
`account.update`, billing edits require account-wide `commercial.edit`, and a
mixed request requires both. Billing fields are redacted unless the reader has
`commercial.edit` or `invoices.read`. The current Partner session, membership,
scope, and required capabilities remain authoritative; MFA is not required.
Same-origin validation, the strong `If-Match`, account row lock, revision
increment, and success audit are all fail-closed controls.

For a profile-update incident:

1. Preserve the correlation ID, actor identity, selected account/membership,
   submitted section names, prior/new profile revisions, response status, and
   audit receipt. Do not copy contact/address values into incident analytics.
2. A `412 revision_mismatch` or `428 if_match_required` is not repaired by
   bypassing the precondition. Refresh the profile, have the partner review the
   current values, and submit again.
3. Confirm the actor had account-wide access and every capability required by
   the submitted sections. A billing-only role must never change organization
   data, and `account.update` alone must never change billing data.
4. If the portal account is disabled, or the membership is scoped, suspended,
   removed, or missing a required capability, keep the write rejected. Do not
   restore access from a legacy contact link.
5. Validate that returned/audited data excludes staff notes, CRM records,
   negotiated rates, internal terms, provider identifiers, and payment data.
   The default PO and cost-center text are partner booking guidance only.
6. Before reopening writes, exercise simultaneous stale updates, partial
   contact/address input, unsafe website URLs, cross-account sessions, each
   capability split, and disabled portal access.

## Media, proof, and document delivery

Alert signals:

- Upload/finalization failures, checksum mismatch, missing required proof, package generation failure, unauthorized download, or storage latency/error rate.

Response:

1. Stop media/package writes if object ownership, account association, or checksum integrity is uncertain. Keep job reads available if they remain tenant-safe.
2. Validate that the media asset is explicitly associated with the account plus draft/job; never repair ownership from a shared CRM contact.
3. Compare stored checksum, decoded/re-encoded derivative state, and package manifest. Quarantine an invalid object rather than marking it ready.
4. For package generation failures, keep the immutable manifest/package version and report generation as incomplete. Do not substitute an older package without labeling it.
5. Revoke exposed share tokens and inspect document/share access logs. Share pages must remain read-only, expiring, revocable, and free of internal notes and sensitive access details.
6. Verify an internal JPEG/PNG/WebP and supported HEIC/HEIF flow, PDF,
   original-media ZIP, expiration, and revocation before reopening globally.

### V2 intake and finalization integrity

Migration `0145_partner_media_tenant_integrity.sql` gives each portal-owned
`media_assets` row an explicit account binding. Composite foreign keys prevent
draft media or job evidence from referencing an asset, parent, or uploader
membership from another account. Its preflight aborts on contradictory parent,
uploader, or multi-tenant asset bindings; operators must quarantine and
reconcile those records instead of changing ownership during migration.

V2 finalization is a durable, account-and-membership-scoped idempotent
operation. The upload-intent checksum cannot be replaced by a later finalize
request. Finalization verifies the stored byte count and SHA-256, detects the
image signature, decodes one bounded frame, rotates orientation, re-encodes
JPEG variants without inherited metadata (including GPS), and verifies every
immutable object after storage. The database may transition an asset to
`ready` only from the operation's claimed `processing` state; failure handling
uses the same claim and cannot overwrite a concurrently completed asset.

When validation proves the staging bytes invalid, the asset records
`replacementRequired`. Replaying the original upload-intent operation rotates
the database pointer to a fresh write-once staging key before returning a new
five-minute upload intent. Provider/processing failures retain the original
staging bytes so finalization can safely retry against any already-written,
checksum-verified immutable variants.

Local evidence on 2026-09-01: focused media integrity/security tests passed
**17/17**, API TypeScript and targeted lint passed, and a fresh PostgreSQL
migration replay reached `0145`. This is not live R2/S3, mobile interruption,
malware-provider, retention-policy, or production-smoke evidence.

## Notification and conversation delivery

### Required Partner Portal provider gate

Booking-created/review-received, schedule-change, and cancellation events pass
through one account-scoped transaction helper. It evaluates the target
membership's `booking_created` or `booking_changed` preference, creates the
in-app record when enabled, and writes one durable channel row to
`partner_notification_deliveries`. Email and SMS rows enqueue only the opaque
delivery ID as `partner.notification.dispatch`; provider destinations, job
scope, notes, addresses, internal appointment IDs, and access details are not
copied into the outbox payload.

External delivery is enabled only when the API and outbox worker share all of
these controls:

- `PARTNER_PORTAL_V2_READS_ENABLED=1`
- `PARTNER_PORTAL_V2_WRITES_ENABLED=1`
- `PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED=1`
- `TEAM_KILL_OUTBOX_DISPATCH` unset/false
- `TEAM_KILL_EXTERNAL_SENDS` unset/false
- the configured email and/or Twilio provider credentials pass their existing
  provider smoke checks

The worker re-reads account, active membership, active identity, channel
preference, and endpoint state immediately before crossing a provider
boundary. SMS may use only the verified, non-revoked
`partner_notification_endpoints` row whose destination, consent timestamp,
source, and version still exactly match the preference snapshot. A legacy
`partner_users.phone_e164` value is never a delivery fallback.

Ordinary email/SMS work due during account-local quiet hours remains queued
until the next quiet-hours end. A reschedule or cancellation classified as a
same-local-day change may bypass quiet hours; booking receipt and review intake
never do. The provider receives the ledger's stable request key. A definite
not-sent result may retry up to three attempts, while uncertain acceptance or
a retry that finds a prior `dispatching` marker moves the ledger to
`reconciliation_required` and must not call the provider again automatically.

Before enabling the production gate, use a Stonegate-owned account to verify
default in-app plus email behavior, explicit SMS opt-in, SMS revocation,
quiet-hours deferral, same-day urgency, external-send containment, and one
provider receipt per ledger row. Reconcile `queued`, `dispatching`,
`accepted`, `failed`, and `reconciliation_required` rows against outbox and
provider evidence; do not manually clone an outbox row to recover a delivery.

Alert signals:

- Oldest outbox age exceeds the operational threshold, repeated provider failure, incorrect participant/job association, or an ambiguous inbound reply.

Response:

1. Use the provider-specific dispatch kill switch before changing queued rows.
2. Confirm the portal-visible job thread is account/job scoped and staff-only messages are excluded at query time.
3. Send ambiguous inbound replies to reconciliation; never guess an account or job from a shared phone/email alone.
4. Correct provider configuration, then retry through the idempotent outbox operation. Do not create replacement messages manually.
5. Respect verified SMS opt-in and quiet hours; urgent same-day schedule changes are the only quiet-hour bypass.
6. Compare in-app state, conversation entry, outbox state, and provider receipt before clearing the incident.
7. For company join decisions, reconcile the single `account_access` in-app record with the deduplicated `message.send` outbox operation. Approval alerts belong to the activated company membership; decline and needs-information alerts belong to the requester's existing active/default portal membership. If that existing membership was suspended or removed after submission, the audited outcome is `membership_unavailable` and email remains the recoverable channel. Respect the member's account-access preference and the portal/provider notification kill switches. Customer-facing copy must never contain the request message, reviewer note, or internal identifiers.

## Partner commercial readiness inventory

Use `/team/partners?p_admin=commercial` to inspect account-bound commercial
posture. The directory reads only records whose `partner_account_id` matches
the displayed company and separates the operational rate-card projection from
the additive versioned rate-card ledger. Its `ready` state means exactly one
currently effective operational rate card has at least one rate item and no
open invoice is missing its hosted-payment link. It does not certify provider
credentials, automatic invoice issuance, approval-policy validity, or payment
settlement.

Treat these findings as containment signals:

- `portal_access_disabled`: do not treat commercial records as an eligible
  partner workspace until the account lifecycle is intentionally enabled.
- `operational_rate_card_missing`, `operational_rate_card_not_current`, or
  `operational_rate_items_missing`: keep uncertain work on staff review; do not
  promise negotiated pricing.
- `overlapping_operational_rate_cards` or
  `overlapping_versioned_rate_cards`: stop instant confirmation and reconcile
  the account/version history before changing pricing.
- `open_invoice_hosted_payment_gap`: leave invoice/payment writes disabled and
  reconcile the invoice through the provider-specific billing workflow.
- `balance_exceeds_safe_display_range`: use the canonical ledger and database
  evidence; do not coerce or truncate the displayed amount.
- `mixed_invoice_currencies`: use currency-specific ledger evidence; the
  inventory deliberately refuses to combine unlike currencies into one total.

The readiness list itself remains read-only. Staff with
`partners.commercial.manage` can select one account and use **Manage approval
rules**; account billing-policy/provider readiness and the contact-oriented
negotiated-rate editor remain unavailable. Do not repair those records with
direct SQL, reuse a contact identifier as account authority, expose hosted
URLs/provider IDs, or trigger provider/payment calls from this inventory.

Partner-managed billing correspondence/address and default booking guidance now
have a canonical account-profile writer. They do not configure payment rails,
invoice policy, or staff commercial controls. Remaining product gaps are
therefore explicit: provider payment-readiness state, canonical account-scoped
rate-card editing, invoice issuance controls, and commercial reconciliation
actions.

### Approval-rule administration

Migration `0150_partner_approval_rule_administration` must be present before
using the editor. Open `/team/partners?p_admin=commercial`, select the intended
company, then choose **Manage approval rules**. Confirm the company name before
creating or changing a rule.

Rules may match service, location, minimum/maximum integer minor-unit amount,
requester role, PO presence, and cost-center presence. Empty selectors mean
“all.” Every matching active rule applies. Decision authority is always the
stable `approvals.decide` capability, and self-approval remains prohibited.
No account may have more than 50 active rules.

Create requires a reason and exact `CREATE APPROVAL RULE`; update or
deactivation requires a reason and exact `UPDATE APPROVAL RULE`. Deactivation
is the supported retirement path—never delete a rule or rewrite historical
approval requests. A request keeps its captured rule and request evidence even
when the source rule is later revised or deactivated.

Operational response:

1. A `404` means malformed, missing, or wrong-account input; return to the
   Commercial list and reselect the account instead of probing identifiers.
2. A stale `If-Match`/revision response means another operator won the update;
   refresh, inspect the new rule, then decide whether to submit a new change.
3. A 50-active-rule conflict requires deactivating an obsolete rule before
   activating another. Do not bypass the cap in SQL.
4. A recent-authentication response requires the operator to renew the normal
   Team session through the supported sign-in flow and resubmit with a fresh
   idempotency key. There is no MFA step-up path.
5. If a service/location selector is unavailable, keep the rule inactive while
   reconciling the catalog or account location. Never substitute a location
   from another company.
6. For any disputed change, reconcile the rule revision, Team creator/updater,
   Staff audit event, and idempotency receipt. If captured approval-request
   evidence changes after creation, stop approval processing and treat it as a
   commercial-integrity incident.

## Location portfolio integrity and bulk intake

Migration `0154_partner_location_portfolio_controls` must be present before
enabling portfolio writes. Every account with an active location has exactly
one active default. Parent/child links, favorites, and import provenance are
enforced with composite account foreign keys; the hierarchy is acyclic.

Partner workflow:

1. Use **Favorite** for a personal shortcut. It does not change another
   member's directory.
2. Use **Make default** only for the location that should prefill new account
   work. Default and hierarchy controls are unavailable to location-scoped
   memberships.
3. Before archive, load **Review archive impact**. Reassign the default first;
   promote or move active children; enter the operational reason; then submit
   exact confirmation. An issued, unexpired Quote V2 proposal awaiting a
   response is a live commercial promise: resolve, expire, supersede, or void
   it before archive. Never deactivate a row directly in SQL or force an
   archive around the commercial guard.
4. For bulk intake, download the canonical template, validate the CSV, resolve
   every row error, and commit only against the directory ETag returned by that
   dry-run. A commit is all-or-nothing. If the directory changed, generate a
   new dry-run rather than forcing the stale snapshot.
5. Treat exact address or external-property-ID matches as duplicate warnings.
   The portal never automatically merges them. Reconcile ownership and archive
   or revise the source record intentionally.

CSV rules:

- Maximum 256 KiB and 500 rows.
- Allowed columns are `site_name`, `external_property_id`, address fields,
  `timezone`, `parent_external_property_id`, and `make_default`.
- Values are validated before storage and are never truncated. Limits are 120
  characters for site name; 100 for external IDs, address line 2, city,
  timezone, and parent external ID; 200 for address line 1; 16 for postal code;
  and exactly a two-letter state code. For example, use `NY`, not `New York`.
- Do not add access instructions, on-site contacts, gate/door/access codes, or
  other secrets to a CSV. Unknown columns are rejected and raw CSV is not
  retained.
- Dry-run evidence expires after 30 minutes and is retained for bounded
  operational troubleshooting for seven days. Run cleanup in small batches:

```sql
SELECT prune_partner_location_imports(now(), 500);
```

Alert or incident response:

1. On a default-consistency, hierarchy-cycle, duplicate, or directory-revision
   conflict, stop the mutation and preserve account, membership, location/import
   IDs, directory/location revisions, idempotency hash, correlation ID, and
   audit evidence. Do not log addresses or CSV row values into analytics.
2. Confirm the selected account and membership scope. Foreign-account and
   same-account out-of-scope IDs must produce the same `404`.
3. For archive failures, reload impact and verify the replacement default and
   parent are active in the same account. If issued-actionable Quote V2 count is
   nonzero, reconcile those proposals through their normal lifecycle; do not
   bypass the guard. Existing jobs remain linked, and already-authorized
   members retain access to bound quote/document evidence after later archive,
   but new responses and issue actions must fail closed.
4. For import uncertainty, verify the dry-run request hash, immutable normalized
   rows/results, retained correction values, requester/committer membership
   provenance, expiry, directory version, and terminal audit. Commit must reject
   stale pre-fix evidence whose original value does not exactly reproduce its
   normalized row. A partially created batch is a P1 integrity incident;
   disable location writes and preserve the transaction evidence.
5. If duplicate locations may represent the same site, quarantine manual
   reconciliation. Never change the account foreign key or merge through a CRM
   contact association.
6. Schedule bounded cleanup and monitor expired-ledger backlog. Cleanup removes
   only eligible import evidence; it never archives locations or jobs.

Focused verification:

```sh
NODE_OPTIONS=--experimental-vm-modules corepack pnpm --filter api exec jest --config jest.partner-portal.config.cjs --runInBand src/__tests__/partner-portal-location-portfolio.test.ts src/__tests__/partner-portal-location-portfolio-route.test.ts src/__tests__/partner-portal-location-archive-impact-route.test.ts
DATABASE_URL="$PARTNER_PORTAL_TEST_DATABASE_URL" NODE_OPTIONS=--experimental-vm-modules corepack pnpm --filter api exec jest --config jest.partner-portal-postgres.config.cjs --runInBand src/__tests__/partner-location-portfolio-controls-postgres.integration.test.ts
corepack pnpm --filter site exec tsx --test src/app/partners/lib/location-portfolio-controls.test.ts
```

### Address verification and duplicate-location review

Migration `0158_partner_location_verification_and_merge` adds provider-neutral
verification evidence, probable-duplicate scoring, a durable Staff queue, and
recoverable same-account location merges. A provider timeout, low-confidence
result, material address correction, or probable duplicate must leave the
location in review and unavailable for instant confirmation. Never copy a
geocode from another tenant or treat a user-entered website/domain as address
proof.

1. Open `/team/partners?p_admin=location-reviews` and compare the entered
   address, bounded provider suggestion, account, requester, and duplicate
   evidence.
2. Staff verification requires independently established latitude/longitude,
   an explicit eligible/outside-area decision, the delegated permission and
   current Team session, a durable note, and exact confirmation. A correction
   request or dismissal never invents trusted coordinates.
3. A location merge is same-account and non-destructive: history remains bound
   to the archived source, the default can move to the destination, and the
   source records a recoverable merge pointer. Open drafts, templates,
   actionable quotes, or active child locations block the operation.
4. Restore only through the matching restore endpoint. Recheck default and
   hierarchy invariants before restoring a source; never clear merge fields in
   SQL.

If Mapbox is unavailable or returns an unreadable response, keep the last
trusted location state, route new/changed addresses to review, and disable
instant confirmation for the affected draft. Preserve only correlation IDs and
bounded provider status in logs—addresses and provider payloads are not
analytics dimensions.

### Account suspension, closure, recovery, and merge

Migration `0156_partner_account_lifecycle_and_auth_retention` provides
revision-safe suspension/reactivation/closure and lost-Administrator recovery.
Migration `0160_partner_account_merge_reconciliation` adds the Owner-only merge
preflight. These operations preserve jobs, proof, documents, messages,
invoices, payments, and audit evidence.

- Suspend when access must stop temporarily; it revokes account-bound sessions,
  pending authentication transactions, and pending purpose challenges without
  affecting the identity's other accounts. Invitations are
  ineligible while the account is suspended and are revoked if it is closed.
- Close only after the Team Owner reviews the durable reason and downstream
  obligations. Closure is access containment, not record deletion.
- Recover a lost Administrator only into an active, portal-enabled account and
  only for an active, password-set, migration-reviewed member. Existing
  sessions are revoked; the recovered user signs in with the normal password
  and session flow.
- Prepare a merge from the source company row, then inspect
  `/team/partners?p_admin=account-merges`. The live database function enumerates
  every nonzero account-owned binding. Populated accounts stay in
  `needs_reconciliation`; the portal never rewrites tenant ownership
  automatically.
- Completion is allowed only for a `ready` empty source, rechecks both account
  revisions and every binding while locked, and then access-disables the
  source with a retained destination pointer. The two trigger-created baseline
  scheduling/cancellation policy rows remain attached to the disabled source
  as configuration evidence and are the only non-blocking bindings.

On any stale revision, unexpected binding, incomplete impact enumeration, or
idempotency mismatch, stop. Keep the source contained, capture the correlation
ID and merge-case ID, and resolve records only through their owning workflow.
Never roll authorization back to CRM contacts and never manually reassign
financial or operational foreign keys.

## Square payment and invoice reconciliation

Alert signals:

- Webhook lag/signature failure, checkout created for the wrong amount, duplicate payment, ACH treated as settled early, invoice allocation mismatch, or hosted/embedded state disagreement.

Response:

1. Disable portal payments and leave invoices readable. Never mark an invoice paid from a return URL or client tokenization result.
2. Preserve payment attempt, invoice snapshot/version, idempotency hash, provider order/payment IDs, sanitized method details, webhook evidence, allocation, and audit rows.
3. Verify the webhook signature and retrieve authoritative provider state. Reject account, currency, amount, invoice, or appointment mismatches into review.
4. Card success may allocate only after verified provider completion. ACH remains pending until settlement/reconciliation.
5. Reconcile duplicate/out-of-order webhooks idempotently; the sum of allocations, refunds, credits, and invoice balance must agree.
6. Exercise sandbox prepare/tokenize/complete, hosted invoice payment, webhook
   replay, failure, and return polling, then run the Stonegate-owned production
   smoke transaction before reopening globally.

No card number, CVV, bank credential, or raw provider payload belongs in Stonegate logs, audit metadata, analytics, or incident notes.

## Read-only staff support preview

Open the Partner Portal preview only from Team partner management and only for a support need tied to the selected account. The route requires trusted staff authentication plus `partners.read`, uses a dedicated account-bound partner-visible read model, and must never create a partner session or expose scheduling, cancellation, messaging, approval, upload, download, payment, or account-management actions.

1. Record the support case, selected account, optional partner job, UTC time, and correlation ID. Confirm a `partner_portal.staff_preview.viewed` audit event was durably written before relying on the response.
2. Treat malformed, missing, and account-invalid job references as the same `404`; do not use alternate searches to infer another tenant's records.
3. Verify the banner says **Read-only support preview**, every returned job has an empty action set, and downloads, payments, messages, and other mutations remain disabled. Never ask the partner for their password, purpose-link token, legacy authentication secret, or session cookie.
4. If the success audit cannot be persisted, the preview must fail closed without returning account data. If any mutation control, internal identifier/secret, foreign-account record, or unaudited successful view appears, stop using the preview, preserve route/audit evidence, revoke the affected staff session as appropriate, and treat possible tenant exposure as P0.

## Account access, invitations, passwords, and sessions

Alert signals:

- Cross-account membership, token replay, suspicious invitation acceptance,
  unexpected privileged access, repeated account switching, a runtime path
  consulting legacy MFA state, or a logout/session-revocation failure.

Response:

1. Disable V2 reads for a suspected tenant leak; disable writes for unsafe membership mutation.
2. Suspend the affected account membership and revoke its sessions through server-side session records. Do not rely on cookie deletion.
3. Revoke pending invitation, verification, activation, reset, and email-change
   credential generations and increment the user security version where
   credentials may be compromised. Routine magic-link login remains disabled
   and is never an authentication fallback.
4. Confirm each purpose-bound token hash, normalized invited email, account,
   role, scope, issuer, generation, expiry, and one-use consumption all match.
   Invitation acceptance must revalidate current issuer authority and must not
   create an authenticated session before password activation completes.
5. For password-login incidents, reconcile the normalized identity, password
   verification outcome, current security version, account/membership
   eligibility, rate-limit outcome, completion audit, and resulting AAL1
   session. A password, session token, or purpose credential must never appear
   in a URL, client prop, analytics event, or log.
6. For activation incidents, verify the source activation challenge is
   purpose-bound and consumed once, password setup or confirmation succeeded,
   the selected account and membership remain eligible, and exactly one normal
   session is created. If the identity or membership was stranded in the former
   activation-MFA handoff, contain it and use the supported password activation
   and Staff reconciliation paths above; do not restore the retired enrollment
   path or perform ad hoc SQL cleanup.
7. For an email-change incident, verify the request used the current password
   or eligible recent session, the target address remained unique, the
   challenge matched the exact user/account/membership/security version, and
   confirmation rotated the security version and revoked every session without
   issuing an automatic login or changing CRM contacts.
8. Preserve the final Administrator rule. Staff recovery must be audited;
   support preview remains read-only.
9. Before reopening, test that tenant-substituted IDs return `404`, every
   privileged operation requires its exact role/capability/scope, suspended or
   removed memberships fail, and revoked sessions fail immediately. No test or
   runbook step should expect an MFA prompt.

## Portal funnel, support reference, and large-account operations

Staff with `partners.accounts.read` can inspect the aggregate Portal operations
view under Partner administration for 1, 7, 14, or 30 days. The stable signals
cover availability requested/available/no-slot/review/degraded, slot
contention, booking start/submission/confirmation/review/failure/abandonment,
and upload start/completion/failure/interruption. Persona is an allowlisted
presentation dimension only and never an authorization input.

Operational response:

1. Compare no-slot and degraded availability separately. No-slot means the
   scheduler returned no feasible window; degraded means availability could
   not be verified and the partner was truthfully routed to review. Do not
   infer either state from a missing event.
2. If a partner reports a portal action or API failure, ask only for the
   displayed **Support reference** and search structured logs by that bounded
   correlation ID. For a later provider-delivery failure, use the opaque job or
   document reference plus the Staff delivery ledger; delivery-history rows do
   not expose correlation IDs. Do not request an address, notes, filename, PO
   value, password, legacy authentication secret, or session token for
   correlation.
3. Upload interruption keeps the selected local batch and stable intent/finalize
   keys for retry. Reconcile ready media before asking the partner to retry;
   never create a replacement job or attach from a CRM contact pool.
4. Treat an invalid or missing aggregate response as unavailable. The Team view
   must not fabricate zeros. It must display the same support reference returned
   by the reporting service, or its own pre-generated reference when the service
   cannot be reached.
5. Job and location directories use bounded, account/filter-bound keyset
   cursors. Migration `0161_partner_portal_operations_query_budgets` adds the
   corresponding account/date, service/date, property/date, location/name, and
   Partner-funnel indexes. Investigate slow plans before raising the 100-row
   API page maximum or 200-row aggregate-key maximum.
6. Product telemetry is server-sanitized even if a client is stale or hostile.
   The ingest route drops noncanonical events on Partner paths, masks dynamic or
   unknown path segments, accepts only fixed event/key/meta dimensions, and
   HMAC-pseudonymizes client session/visit identifiers before storage. Any
   address, contact, note, filename, job/share token, campaign, referrer, postal
   code, PO, or billing value in Partner analytics is a privacy incident:
   disable ingest, preserve the correlation ID and safe schema evidence, and
   remove the unsafe dimension before reopening.

Focused verification:

```sh
NODE_OPTIONS=--experimental-vm-modules corepack pnpm --filter api exec jest --config jest.partner-portal.config.cjs --runInBand src/__tests__/partner-product-analytics.test.ts src/__tests__/partner-portal-product-analytics-ingestion.test.ts src/__tests__/partner-portal-operations-reporting.test.ts src/__tests__/partner-portal-operations-route.test.ts src/__tests__/partner-portal-query-budgets.test.ts
corepack pnpm --filter site exec tsx --test src/app/partners/lib/portal-v2-support.test.ts src/app/partners/lib/product-analytics.test.ts src/app/partners/lib/operations-reliability.test.ts src/app/partners/lib/upload-with-progress.test.ts
DATABASE_URL="$PARTNER_PORTAL_TEST_DATABASE_URL" NODE_ENV=test corepack pnpm --filter api exec jest --config jest.partner-portal-postgres.config.cjs --runInBand src/__tests__/partner-portal-operations-query-budget-postgres.integration.test.ts
```

Raw web events and web-vital samples remain subject to the existing 30-day
cleanup. Aggregated daily funnel totals contain no identity/account/job or free
text and are used only for reliability trends. Authentication challenge and
session metadata follow the separate 90-day scrub policy.

The outbox worker invokes `prune_partner_authentication_metadata` every 24
hours by default (`PARTNER_AUTH_RETENTION_INTERVAL_MS=86400000`) in bounded
500-row batches (`PARTNER_AUTH_RETENTION_BATCH_SIZE=500`). The procedure
expires or deletes unusable credentials and scrubs detailed network/device
metadata while retaining account, membership, application, and audit evidence.
If a result reports `batchMayHaveMore`, repeat the worker pass until it clears;
do not increase the batch above 5,000. Alert on a missed 48-hour window or a
repeating execution error, verify the `partners.auth_retention.completed`
structured event, and never repair retention by deleting identities or audit
rows.

## Verification commands

Run from the repository root:

```sh
corepack pnpm typecheck:partner-portal
corepack pnpm test:partner-portal
corepack pnpm test:e2e:partner-portal
```

Real-PostgreSQL Partner Portal evidence was refreshed on 2026-09-02 against
disposable PostgreSQL 16.14 migrated through `0162`. Run the source inventory
and the complete database gate with a fresh, non-production URL.

That migration replay reaches the intended expand-release database boundary but
must not be presented as evidence that the MFA runtime removal works. Before
release, run the new application against a representative non-production
snapshot with legacy MFA state left intact, exercise old/new runtime overlap and
pre-cutover coexistence, confirm both Team and Partner password/session flows
ignore that state, rehearse flag/maintenance/read-only containment plus a
forward fix, and rerun the complete authentication and authorization gate. Do
not add or run a cleanup migration in this phase, and do not rehearse restoring
the mandatory-MFA runtime as a valid post-activation rollback.

```sh
corepack pnpm --filter api exec jest --config jest.config.cjs --runInBand src/__tests__/schedule-writer-inventory.test.ts
DATABASE_URL="$PARTNER_PORTAL_TEST_DATABASE_URL" corepack pnpm db:migrate
DATABASE_URL="$PARTNER_PORTAL_TEST_DATABASE_URL" NODE_ENV=test corepack pnpm test:partner-portal:postgres
```

The exhaustive source inventory remains part of the passing API lane. The full
PostgreSQL suite passed **19 suites / 73 tests**: one of two simultaneous holds won the last
capacity unit; a locked release allowed exactly one replacement claim; a hold
waited for staff cancellation and re-read the committed schedule; duplicate
submit replayed one booking and one appointment; a replacement hold defeated a
competing staff schedule mutation; and cancel-versus-confirm ended with
matching booking/appointment states. This is database concurrency evidence,
not production smoke or cutover evidence.

The dedicated Partner PostgreSQL lane passed **24/24** across seven suites on
the same PostgreSQL 16.14 database. Its recurring-series lifecycle suite passed
**4/4 twice consecutively**: simultaneous identical keys produced one terminal
receipt and one exact replay; different-key actions produced one CAS winner and
one stale-revision rejection; horizon lease recovery and lifecycle mutation
left no `evaluating` row or outside-horizon reservation; and stale `If-Match`
changed no series, occurrence, audit, or receipt.

For the single external cutover, also apply all migrations to a fresh PostgreSQL
16 database, run the real-PostgreSQL concurrency suites, rehearse restore and
global flag switching on a production-sized snapshot, exercise provider
sandboxes plus Stonegate-owned production smoke accounts, and complete the
manual WCAG/browser matrix recorded in the audit ledger. A passing unit lane
does not substitute for those checks.

## Resolution evidence

An incident may be closed only when the record includes:

- Root cause and affected account/job/payment scope.
- Exact switch changes and timestamps.
- Reconciliation results for accepted bookings, holds, schedule blocks, outbox work, media/documents, and payments as applicable.
- Automated regression reference and fresh-database migration evidence.
- Canary account, actor, UTC time, correlation IDs, and outcome.
- Confirmation that no unresolved tenant exposure, double booking, unreconciled payment, or silent notification loss remains.
