# Partner Portal operations and incident runbook

- Owner: Stonegate operations and engineering
- Scope: authenticated Partner Portal V2, its public access/invitation/proof handoffs, and supporting staff workflows
- Default posture: preserve accepted records, stop unsafe writes or promises, and route uncertain work to staff review
- Last updated: 2026-08-31

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
6. Reproduce with a seeded canary account before reopening a cohort.

## Rollout and rollback switches

| Switch                                          | Safe effect when disabled                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTNER_PORTAL_V2_READS_ENABLED`               | Removes V2 account data from service. Use only for exposure or unsafe serialization incidents.                                                                             |
| `PARTNER_PORTAL_V2_WRITES_ENABLED`              | Stops V2 mutations without deleting drafts, jobs, proof, invitations, or commercial records.                                                                               |
| `PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS`          | Restricts V2 to explicitly listed account UUIDs for canary isolation.                                                                                                      |
| `PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED`   | Keeps intake available but routes eligible requests to review instead of promising capacity.                                                                               |
| `PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED`        | Stops creation/refresh of Square-hosted invoice payment links; invoice and payment history remains read-only.                                                              |
| `PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED`      | Stops creation/completion of embedded card payment operations without disabling hosted invoice links.                                                                      |
| `PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED` | Stops new portal external-delivery work; in-app records and queued evidence remain.                                                                                        |
| `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED`   | Stops the worker from claiming tentative recurring occurrences. Future occurrences remain explicitly tentative and no new hold or appointment is created by the evaluator. |
| `PARTNER_RECURRING_HORIZON_BATCH_SIZE`          | Bounds one evaluator pass to 1–100 occurrences; default is 20. Lower this during a cautious canary or recovery.                                                            |
| `PARTNER_RECURRING_HORIZON_INTERVAL_MS`         | Controls evaluator cadence; default is 300,000 ms and values below 60,000 ms fall back to the safe default.                                                                |
| Provider/outbox kill switches                   | Prevent worker dispatch before provider calls. Verify the worker service has the same values as the API service.                                                           |

Rollback sequence for an unknown production defect:

1. Disable instant confirmation.
2. Disable V2 writes.
3. Restrict canary membership if reads remain safe.
4. Disable V2 reads only for a suspected tenant or serialization exposure.
5. Keep workers stopped for the affected provider until queued operations are inspected; do not discard queued rows.

Re-enable in reverse order using internal accounts, then a small account allowlist. A rollback is incomplete until accepted bookings, holds, payments, and outbox rows created around the incident have been reconciled.

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
only after a representative canary has enough traffic.

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
4. Run synchronization against the canary calendar. Verify the coverage timestamp advances and a known busy event removes capacity.
5. Confirm stale dependencies still accept a clearly labeled review request rather than a confirmed slot.
6. Re-enable instant confirmation only after two successful sync cycles and a canary availability/hold/submit journey.

## Recurring horizon evaluation

The outbox worker evaluates only active-series occurrences that have entered the account-local 30-day booking horizon. Anything later remains `tentative`; it has no hold, appointment, or reserved capacity. Each due occurrence is claimed with a bounded lease and evaluated through the same availability, hold, and booking-submission services as an interactive portal request. Review and failure outcomes create an account-scoped staff task when the account has its required portal contact anchor.

Safe enablement:

1. Confirm `PARTNER_PORTAL_V2_READS_ENABLED` and `PARTNER_PORTAL_V2_WRITES_ENABLED` are enabled for the intended canary accounts and keep `PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS` narrow.
2. Start with `PARTNER_RECURRING_HORIZON_BATCH_SIZE=1` and the default `PARTNER_RECURRING_HORIZON_INTERVAL_MS=300000`.
3. Set `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED=1` on `stonegate-outbox-worker` only.
4. Verify one occurrence transitions from `tentative` through evaluation to `confirmed`, `review`, or `failed`; confirm a review/failed occurrence has a matching open CRM task and that no occurrence beyond day 30 changed.
5. Reconcile the booking draft, opaque partner job ID, promised two-hour arrival window, hold disposition, appointment capacity, audit event, and any calendar outbox event before increasing the batch size.

If confirmations, capacity, or tenant scope are uncertain, disable `PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED` first, then disable instant confirmation. A pass already in progress may finish its claimed occurrence atomically; wait for that pass to settle and reconcile it. Do not delete tentative occurrences or manually create replacement appointments. Stale `evaluating` leases are reclaimed idempotently after 15 minutes when the evaluator is safely re-enabled.

## Service catalog and add-on pricing

Migration `0127_partner_service_add_ons.sql` seeds the canonical junk-removal add-ons and maps the existing staff rate tiers to them: `mattress_fee` → `mattress_disposal`, `paint_fee` → `paint_can_disposal`, and `tire_fee` → `tire_disposal`. The Team partner-rate editor starts new configurations at **$30 per mattress** and **$10 per paint can or tire**. These are editable starting defaults, not a promise for every account; saving the complete negotiated rate card is the supported workflow that binds it to the portal account and dual-writes canonical per-unit add-on prices.

The seeded junk-removal scheduling profile is deliberately review-only: `instant_confirmation_enabled` is false and pricing eligibility carries `reviewRequired`. Existing fee rows are backfilled where possible, but a missing account-bound rate card, missing add-on price, excessive add-on quantity, or disclosed restricted/non-standard scope must remain a review request.

Safe enablement:

1. Apply the migration to a fresh database and the canary environment. Verify the account has one effective base-rate card plus the expected canonical add-on rows; never copy prices between accounts.
2. With instant confirmation disabled, compare the catalog as a `rates.read` member and a limited member. The first may see negotiated amounts; the second must receive the same selectable scope with prices hidden.
3. Submit canary drafts with no add-ons and with each add-on at multiple quantities. Confirm the API—not the browser—calculates base, unit, line, add-on, and total amounts and persists the selected tier and immutable add-on snapshot on the job.
4. Tamper with a tier, add-on key, duplicate selection, quantity, account, or client-supplied price. The mutation must fail safely or route to review without changing another account's data or accepting the supplied amount.
5. Verify high quantities and the `restrictedItems`/`nonStandard` disclosures produce review reasons while preserving the request. Do not remove these review gates merely to make a slot confirmable.
6. Enable the service profile for instant confirmation only after duration, travel buffer, capacity pool, service territory, effective pricing, and current calendar coverage are approved. Then enable the global instant-confirmation switch for a narrow canary account and reconcile appointment quoted total, booking snapshots, public job DTO, audit, and calendar outbox state before widening access.

## Holds, capacity, and schedule mismatch

Alert signals:

- Duplicate active holds for the same operation, peak capacity above a pool limit, schedule/advisory-lock errors, or a job promise differing from its account booking record.

Response:

1. Disable instant confirmation. Disable V2 writes if actual double booking or cross-channel serialization is uncertain.
2. Preserve the conflicting appointment, hold, policy revision, resource-pool, schedule-block, idempotency, audit, and outbox rows.
3. Identify the canonical global schedule-lock transaction that wrote each row. Do not manually move one job before both customer promises are reviewed.
4. Expire only genuinely expired active holds through the normal release path. Never release a hold already consumed by a booking.
5. Run the Partner Portal scheduling/concurrency release lane against a fresh PostgreSQL database.
6. Staff must contact affected partners before any promised-window correction. Reopen instant confirmation only after a production-equivalent race test and canary booking pass.

## Approval holds and review-only requests

Account approval is resolved from the current server-side rule set; a browser field or saved draft flag can never require, bypass, or satisfy approval. A qualifying request keeps one candidate as a 30-minute approval hold, remains visibly unconfirmed, and cannot be approved by its requester. Approval consumes a still-valid hold atomically with the appointment, public job, audit entry, and calendar outbox event. If the hold is missing or expired, the immutable decision remains approved but the job becomes `approved_needs_reschedule`; no schedule promise is manufactured.

Requests caused by missing slots, uncertain scope, stale calendar coverage, missing routing/geocoding, unconfigured service/pricing, or operational review are different: they retain one to three preferred dates only and reserve no capacity. Their appointment has no internal start or promised arrival window until staff safely schedules it.

When approval or review state disagrees:

1. Disable instant confirmation, preserve the draft, approval request/decision, hold, job, appointment, audit, and outbox rows, and do not recreate a decision.
2. Verify the requester and decision maker are different active memberships in the same account and that the approver completed MFA step-up.
3. Compare the captured rule snapshot with the version that applied at submission. Later rule edits must not rewrite it.
4. For a valid approval hold, reconcile one consumed hold, one scheduled appointment, one confirmed partner job, and one calendar-sync request with reason `partner.portal.v2.booking.approval_confirmed`.
5. For an expired approval hold, verify the appointment remains unscheduled and route the approved request through the normal reschedule/availability workflow.
6. For review-only intake, verify no active/consumed hold, internal appointment start, promised window, or capacity claim exists. Staff may schedule only through the canonical scheduler.

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

## Media, proof, and document delivery

Alert signals:

- Upload/finalization failures, checksum mismatch, missing required proof, package generation failure, unauthorized download, or storage latency/error rate.

Response:

1. Stop media/package writes if object ownership, account association, or checksum integrity is uncertain. Keep job reads available if they remain tenant-safe.
2. Validate that the media asset is explicitly associated with the account plus draft/job; never repair ownership from a shared CRM contact.
3. Compare stored checksum, decoded/re-encoded derivative state, and package manifest. Quarantine an invalid object rather than marking it ready.
4. For package generation failures, keep the immutable manifest/package version and report generation as incomplete. Do not substitute an older package without labeling it.
5. Revoke exposed share tokens and inspect document/share access logs. Share pages must remain read-only, expiring, revocable, and free of internal notes and sensitive access details.
6. Verify a canary JPEG/PNG/WebP and supported HEIC/HEIF flow, PDF, original-media ZIP, expiration, and revocation before reopening.

## Notification and conversation delivery

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

## Square payment and invoice reconciliation

Alert signals:

- Webhook lag/signature failure, checkout created for the wrong amount, duplicate payment, ACH treated as settled early, invoice allocation mismatch, or hosted/embedded state disagreement.

Response:

1. Disable portal payments and leave invoices readable. Never mark an invoice paid from a return URL or client tokenization result.
2. Preserve payment attempt, invoice snapshot/version, idempotency hash, provider order/payment IDs, sanitized method details, webhook evidence, allocation, and audit rows.
3. Verify the webhook signature and retrieve authoritative provider state. Reject account, currency, amount, invoice, or appointment mismatches into review.
4. Card success may allocate only after verified provider completion. ACH remains pending until settlement/reconciliation.
5. Reconcile duplicate/out-of-order webhooks idempotently; the sum of allocations, refunds, credits, and invoice balance must agree.
6. Exercise sandbox prepare/tokenize/complete, hosted invoice payment, webhook replay, failure, and return polling before reopening the canary cohort.

No card number, CVV, bank credential, or raw provider payload belongs in Stonegate logs, audit metadata, analytics, or incident notes.

## Read-only staff support preview

Open the Partner Portal preview only from Team partner management and only for a support need tied to the selected account. The route requires trusted staff authentication plus `partners.read`, uses a dedicated account-bound partner-visible read model, and must never create a partner session or expose scheduling, cancellation, messaging, approval, upload, download, payment, or account-management actions.

1. Record the support case, selected account, optional partner job, UTC time, and correlation ID. Confirm a `partner_portal.staff_preview.viewed` audit event was durably written before relying on the response.
2. Treat malformed, missing, and account-invalid job references as the same `404`; do not use alternate searches to infer another tenant's records.
3. Verify the banner says **Read-only support preview**, every returned job has an empty action set, and downloads, payments, messages, and other mutations remain disabled. Never ask the partner for their magic link, password, MFA code, recovery code, or session cookie.
4. If the success audit cannot be persisted, the preview must fail closed without returning account data. If any mutation control, internal identifier/secret, foreign-account record, or unaudited successful view appears, stop using the preview, preserve route/audit evidence, revoke the affected staff session as appropriate, and treat possible tenant exposure as P0.

## Account access, invitations, sessions, and MFA

Alert signals:

- Cross-account membership, token replay, suspicious invitation acceptance, admin without MFA, repeated account switching, or a logout/session-revocation failure.

Response:

1. Disable V2 reads for a suspected tenant leak; disable writes for unsafe membership mutation.
2. Suspend the affected account membership and revoke its sessions through server-side session records. Do not rely on cookie deletion.
3. Revoke pending invitation/magic-link generations and increment the user security version where credentials may be compromised.
4. Confirm invitation token hash, normalized invited email, account, role, generation, expiry, and one-use acceptance all match. Never move an invitation between accounts.
5. Preserve the final administrator rule. Staff recovery must be audited; support preview remains read-only.
6. Test tenant-substituted IDs return `404`, MFA step-up is required for administrator/approver/billing operations, and revoked sessions fail immediately before reopening.

## Verification commands

Run from the repository root:

```sh
corepack pnpm typecheck:partner-portal
corepack pnpm test:partner-portal
corepack pnpm test:e2e:partner-portal
```

For a release/canary, also apply all migrations to a fresh PostgreSQL 16 database, run the real-PostgreSQL concurrency suites, exercise provider sandboxes, and complete the manual WCAG/browser matrix recorded in the audit ledger. A passing unit lane does not substitute for those checks.

## Resolution evidence

An incident may be closed only when the record includes:

- Root cause and affected account/job/payment scope.
- Exact switch changes and timestamps.
- Reconciliation results for accepted bookings, holds, schedule blocks, outbox work, media/documents, and payments as applicable.
- Automated regression reference and fresh-database migration evidence.
- Canary account, actor, UTC time, correlation IDs, and outcome.
- Confirmation that no unresolved tenant exposure, double booking, unreconciled payment, or silent notification loss remains.
