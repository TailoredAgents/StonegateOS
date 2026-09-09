# Partner service workspace: release and recovery

Status: implementation and local verification, not approved for production cutover. This runbook supplements the historical operations/single-cutover runbooks. When they conflict, the September 8 relationship-first plan controls: no public application funnel, no MFA requirement, CRM-owned invoice balances, embedded Square collection, and no selected-partner canary.

## Always available help

Need access or help? Email sales@stonegatejunkremoval.com or call 404-777-2631.

Do not ask partners for passwords, invitation tokens, bank details, or card numbers. Do not place addresses, notes, filenames, phone numbers, payment payloads or access codes into incident analytics. Use correlation IDs and internal account/job IDs in access-controlled operational logs only.

## Release gates

1. Review every row in `docs/audits/partner-portal-simplicity-audit-2026-09-08.md` and the still-applicable historical 99-finding ledger. Implemented code is not provider, usability, accessibility or cutover certification.
2. Recheck current production identity/account, service-profile, price and calendar configuration with read-only queries. The audit's zero-account counts are historical, not a continuing assumption.
3. Use Stonegate-owned test accounts and controlled recipients in staging. Exercise all four roles, location restrictions, multiple accounts, suspension, last-Administrator protection, every old access-link outcome, expired/revoked invitations, and successful first/existing-person activation.
4. Run actual returning-partner requests, review handling, confirmed booking, rescheduling, cancellation, staff replies/internal notes, completion/proof/downloads, and CRM billing. Include more than 100 records and uncertain dependency states. Record browser/device/zoom and screen-reader results separately. Do not claim three-minute or 90% usability targets without representative tests.
5. Test ordinary CRM Complete job and the current commission/Spend/payout refresh. Do not restore MFA or apply partner-proof rules to CRM-contact pools.
6. Certify real storage, scanning, email, opted-in SMS, Google/Mapbox and Square behavior. Never enable unfinished production features because a page exists.
7. Back up production immediately before the approved cutover. Rehearse restoration into a separate database and run the migration assertions there. Record backup identity/checksum, restore duration and rollback decision owner. Never use a broad destructive command against the workspace or production database.
8. Run the migration chain through `0171_partner_payment_allocation_reconciliation` using the existing migration runner. Its 169-entry fresh local schema and separate restore rehearsals passed; a production-sized restore rehearsal is a separate gate. Migration 0170 enables draft-line corrections without weakening issued evidence; 0171 adds account-safe, immutable financial-correction evidence. Do not apply or reverse migrations automatically from this document.
9. At the scheduled single cutover, apply the existing canonical-session/authorization procedures and enable only certified reads/writes. Keep routine magic login disabled. Do not revert authority to CRM contacts. Confirm anonymous entry, password login, stale-session recovery and tokenless native POST work on the custom domain.

## Company access and support

Use `/team/partners` → Accounts → Set up partner access. Select a known relationship explicitly or deliberately create a distinct company. Never infer a company merge from name, address or domain similarity. Select service readiness, role and validated location/cost-center restrictions; send one invitation. New companies default to one before and one after image.

Invitations expire after seven days, are single-use and revocable. Resending replaces prior generations. Opening the email alone cannot activate access. New people create a password; existing people confirm their current password. For failed delivery, inspect the invitation/outbox status and use the explicit resend action; do not paste tokens into logs or directly flip membership states. Company Administrators may invite coworkers but cannot approve a new company or enable Stonegate-only tools.

Retired application APIs return `workflow_retired`; historical statuses remain readable and old valid activation links retain their intended outcome. An old applicant cookie must not trap someone in the application route. MFA routes are compatibility redirects, not security requirements.

If sign-in verification is unavailable, preserve the session cookie, show private retry/help, and investigate the session API/correlation ID. Never turn cookie presence or a `null` Origin into authentication. Tokenless native forms use same-origin referrers; token handoffs retain no-referrer/no-store.

Suspending one company membership must not silently select another company for an in-flight action. The affected account returns an access error; the person can explicitly switch to an eligible company or sign in again. Do not globally disable the identity to resolve an account-specific access issue. Invitation inspection accepts forwarded client addresses only from the configured trusted-proxy hop chain; verify that configuration on the actual deployment before relying on per-client rate limits.

## Scheduling and review

An enabled relationship can request `service_request` without negotiated prices or a scheduling profile. A review request does not reserve time. Staff Operations includes both new service requests and preferred-date reschedule requests. Read the submitted location/contact/scope snapshot and photos, then use canonical scheduling—not direct SQL—to confirm an eligible time. Approval requirements cannot be bypassed by a status-only confirmation.

The partner promise is a full two-hour arrival window. Internal candidates use 30-minute increments, configured duration and travel/cleanup occupancy, resource-pool units, holds, local-day policy and durable busy blocks. The normal horizon is next local day through 30 days. An uncertain service/geocode/price/profile/calendar condition must remain review-only. Calendar freshness beyond 15 minutes cannot support automatic confirmation.

For preferred-date rescheduling, retain the old appointment until staff accepts a validated replacement. Decline/withdrawal cannot erase that appointment. Review the request's current revision before a decision.

Google mirror edits are not an alternate partner scheduler. Partner remote moves/cancellations preserve the CRM schedule/status and invalidate calendar coverage until staff reconciles the discrepancy through the canonical scheduler. Ordinary remote moves also pass the shared weighted conflict checks; a conflicting update rolls back and invalidates coverage without discarding previously imported blocks. Unmatched busy events continue to block capacity. Do not mark stale calendar data fresh merely to reopen availability.

For a conflict or dependency incident, disable instant confirmation first and keep truthful review intake if safe. Review shared writer inventory and policy parity before release; a lock alone is not evidence of correct capacity.

Configure named crew/equipment in `/team/partners/scheduling` before enabling services that require them. CRM and partner review/reschedule controls can select explicit resources or request validated automatic assignment. A stale, unqualified, inactive or conflicting selection is rejected without replacing the previous appointment. Availability reads use a bounded snapshot of the shared conflict inspector; the write transaction still reloads everything under lock. Public channels retain their own notice/horizon presentation and do not invent partner service profiles. Online Back/autosave tests do not establish offline/browser-crash request recovery.

Schedule-writer inventory classification: `partner-change-order-price.ts` is a financial-metadata-only appointment writer. Under the appointment collection lock it changes only `quotedTotalCents`, `quotedTotalMaxCents` and `updatedAt`; it does not change appointment status, start, duration, travel buffer, capacity or resource assignments. Accepted price changes do not constitute a schedule mutation.

## Photos, scanned documents and completion

Private image and document intents expire after five minutes. Job download routes renew authorization and signed URLs; expired URLs are not a reason to expose storage publicly. Images are limited to 10 MB each/40 per job. Before/after requirements allow at most 20 each. Every upload needs explicit account/draft/job ownership.

PDF uploads are limited to 10 MB, signature/checksum checked, and held in private quarantine. Configure `PARTNER_CLAMAV_SOCKET`, or a private-network `PARTNER_CLAMAV_HOST` plus `PARTNER_CLAMAV_PORT` (default 3310). ClamAV's TCP protocol has no built-in transport authentication/encryption: never expose it to the internet. Maintain fresh signatures, `StreamMaxLength` sufficient for 10 MB, daemon health and private network access. Certify clean files, EICAR detection, unavailable daemon, timeout, malformed response, interrupted upload and retry. Protocol stubs are not certification of a real scanner. Unknown/unscanned/infected files cannot satisfy proof requirements.

Each job retains its full 40-photo allowance plus a separate bounded 10-PDF allowance. Completion originals are processed sequentially into a private temporary ZIP, then uploaded and verified as known-length streams. Plan at least 1 GiB free temporary disk per concurrently active package job and measure real worker memory under its actual workload; the local 40 × 10 MiB test observed about 278 MiB peak RSS. Multiple worker processes multiply resource needs. Storage/worker failure leaves accepted job and financial records intact; retry the same outbox operation. Do not clear immutable objects or evidence to force a retry. The actual local ClamAV/S3 and HEIC checks are recorded in the September 9 verification report, not evidence of production setup.

`partner.document.scan` and `partner.proof.prepare` run through the worker. Eligible completion prepares immutable versioned PDF/original-photo ZIP records; partners only need Download completion record. Generation failure must remain visible/retryable without claiming the package is ready. Do not regenerate old versions in place. Prove checksum, tenant isolation, expiry/revocation and private storage behavior against the actual provider before enabling.

Deleted evidence remains recoverable for 30 days; use Undo/recently removed/authorized restore. No automatic destructive retention of proof or financial records is approved. Ordinary CRM Complete job remains unaffected unless the appointment is explicitly a partner job. An authorized proof override needs a reason.

## Conversations and notifications

Exactly one operational portal-visible thread belongs to each partner job. Staff choose Reply to partner or Internal note explicitly. No-contact web threads must be usable in both CRM Inbox clients. Internal notes remain excluded by the partner query, not merely hidden in the UI. Do not infer recipients from a CRM contact shared by several companies.

Committed request, schedule, arrival, approval, message, completion/proof and financial events feed the outbox. Retry original operations with their idempotency identity. Recheck current membership, location and financial permissions when delivery is delayed. Ambiguous inbound replies require reconciliation, not a guessed job association.

Email and in-app updates are defaults; SMS requires separate personal phone verification and opt-in. Honor quiet hours except urgent same-day changes. A failure marking an update read must not prevent opening the job. Inspect delivery state and outbox age before resending. Never bypass fail-closed external-send switches to clear a backlog. Internal notes do not need external-delivery permission.

## CRM billing and Square

Staff Commercial can create/review/issue invoices, record/apply payments, credit, void eligible invoices, request refunds and generate statements. Issued lines/terms and finalized document versions are immutable. Correct them through audited operations, not SQL edits. CRM calculations are authoritative across cash/check, Square, deposits, allocations, refunds and credits. Tips are not invoice principal. Issuing an invoice must not duplicate revenue or change commission rules.

Overdue labels and filters use the due date immediately; a due date includes the entire Eastern calendar day. This display calculation does not issue or modify an invoice. Staff invoice document/refund sections load their own complete cursor history; use View history, Load older records and Refresh. An initial unloaded section is not an empty history, and a failed older-page load must retain the already-loaded records.

Before online collection, inventory all legacy hosted attempts/URLs. Verify provider-side retirement or settlement; uncertain payable links must block replacement collection. Expiring/dismissing a local row is not proof an external link is dead. No new hosted invoice workflow replaces the CRM ledger.

Embedded `invoice_balance` checkout defaults to the full server-calculated payable balance. Partial collection requires explicit account configuration. Square tokenizes card/ACH; do not collect credentials on Stonegate servers. Certify HTTPS/CSP, duplicate and out-of-order webhooks, settled retry, concurrent cash/online collection, partial payments, tip separation, refunds, failed payments, credits and voids. Provider calls stay outside DB transactions with durable recovery. ACH remains pending until provider settlement or authoritative failure; a local timeout cannot release it as canceled.

If reconciliation is uncertain, stop additional collection and retain the durable intent/reservation. Do not manufacture a receipt or mark an invoice paid from a browser redirect. Resolve provider state, then let the shared allocation/reconciliation path update the CRM. Preserve accepted money during rollback.

An accepted pre-finalization change order updates the CRM quoted price, not finalized revenue. Revise an existing draft before issue. An unpaid issued invoice may be explicitly voided and replaced only after external obligations are retired. Completed/finalized work, settled or pending payments and uncertain collection attempts continue to block automatic changes to the original job price.

The owner approved this policy on September 9: **extra work after a finished/paid job is a new, linked job with its own price, invoice, payment and crew payout.** It is not an automatic correction of the original bill. On the original partner job, use **Request additional service**, describe only the new work, select its location/timing, and submit through the normal request flow. A saved request is not a confirmed job. Normal pricing, approval, scheduling and review checks still apply. The original bill, payment and payout remain unchanged.

Staff can see the original-job reference in Service requests, open its read-only context, and return to the new request. Price/quote and bill only the new job. A new quote must belong to the new job and its own opportunity; do not reuse the original quote/opportunity or reinterpret an existing change order's total as the price of extra work. Use the existing audited reconciliation/credit/refund tools for genuine corrections, not this new-work path. Pending or uncertain payments are not treated as settled solely to enable this action.

Migration `0172_partner_additional_service_jobs` adds nullable account-safe immutable links to drafts/jobs; it changes no existing financial records. Links do not grant access: parent and child location/account permissions are checked separately, and changed access can make an old link or saved request unavailable. Retry an uncertain creation with its original idempotency key. Apply this migration before deploying the new code. Rollback can disable V2 writes while retaining the linked jobs and all accepted financial records; never unlink or rewrite past payments to roll back.

For ambiguous legacy allocations, open the staff billing reconciliation panel for the exact account/job. Inspect the genuine payment, tip, refund and invoice evidence. Select every affected payment, allocate its complete principal and refund splits, and provide a reason and evidence reference. Review the proposed result before confirming. The command requires the current revision, an idempotency key and commercial authority. If the response is uncertain, retry the unchanged plan with the same key; do not submit a different payment collection. A mismatch in account/job ownership, unresolved provider obligation or unsupported historical paid amount remains contained. Corrections append immutable evidence and update the shared allocation projection; they do not erase payments, change issued invoice lines or recompute commissions. Audited corrected allocations are recognized during duplicate settlement replay; unaudited projection changes enter review.

If a genuine historical cash/check receipt is missing from canonical payment records, use the dedicated historical-receipt repair—not Record new payment. Enter its actual received date, principal, evidence reference, reason and complete reviewed allocations. Confirm that there is no unrecorded tip. This can support only the unexplained legacy paid principal; future receipts, overfunding, uncertain provider money and unsupported refunds remain blocked. It records money already received and sends no new settlement notification. Do not backdate a new collection. Missing tips require explicit payroll review; missing Square payments require provider reconciliation rather than a manufactured manual receipt.

Normal projection must preserve unexplained historical paid principal until it is reconciled; the presence of one allocation is not proof that all old money is represented. Statement refunds validate the complete allocation split but count only their included invoices. Reconcile period boundaries and cross-invoice splits before approving statements, without modifying the original payment, job revenue or commission record.

## Optional tools

Staff workflow settings govern new templates, recurring service, bulk intake, reports and portfolio tools. Roles still limit authority. Hiding a button is not the API gate. Disabling a tool preserves history and stop/archive maintenance; saved history is available from settings. Re-enabling does not silently resume a paused series.

Disabling recurring service requires explicit confirmation and pauses future tentative work without canceling confirmed jobs. Account/series changes serialize with worker claims; a worker must revalidate the current series and tool state before obtaining a hold or submitting its bound occurrence draft. A previously claimed draft is not permission to bypass a later pause. Each occurrence gets independent horizon/eligibility evaluation. Never auto-charge recurring service. Review worker failures rather than inventing future reservations.

Bulk CSV has a 100-row maximum, persisted validation/history, explicit submission, per-row idempotency and bounded worker leases. Resume the existing batch on failure. Confirm rows are actual jobs/review requests, not drafts labeled submitted. Reports export a bounded fixed snapshot; an oversized request must ask for narrower filters, never return a silently truncated total. Keep ordinary invoice downloads available when advanced reports are disabled.

## Monitoring and rollback

For 48 hours after authorized cutover, monitor login/session failures, request submission, review queues, calendar freshness, capacity conflicts, outbox age/delivery failures, upload/scan/package failures, recurring failures, payment reservations, webhook lag and CRM/provider reconciliation. Assign a named staff responder and record actual observation timestamps; no such production monitoring has run yet.

Use existing narrow feature switches: `PARTNER_PORTAL_V2_WRITES_ENABLED`, `PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED`, `PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED`, `PARTNER_PORTAL_EMBEDDED_ACH_ENABLED`, and `PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED`, together with existing global operational kill switches. Confirm effective flag behavior before every change. Read-only/review-only maintenance is safer than unproven confirmation or collection. Preserve accepted jobs, payment state, evidence and history. Never restore legacy contact-derived authorization, unsafe public applications or MFA requirements as a rollback shortcut.

## Local verification commands

Use a disposable fully migrated PostgreSQL database, not the active production URL, for the opt-in database lane.

```sh
pnpm --filter api typecheck
pnpm --filter site exec tsc --project tsconfig.typecheck.json
pnpm test:partner-portal:api
pnpm test:partner-portal:site
pnpm test:partner-portal:postgres
pnpm test:partner-portal:resource-browser
pnpm test:partner:booking-components
pnpm exec tsx --test scripts/test-partner-service-browser.mts
pnpm exec tsx --test scripts/test-partner-staff-inbox.mts
pnpm test:partner-portal:staff-billing-browser
pnpm test:partner-portal:staff-resource-browser
pnpm test:partner-portal:browser-relationships
pnpm test:partner-portal:staff-reconciliation-browser
pnpm test:partner-portal:template-proof-browser
pnpm test:partner-portal:communications-browser
pnpm test:partner-portal:worker-runtime
pnpm test:partner-portal:proof-memory
pnpm --filter api build
pnpm --filter site build
```

The rendered browser suite requires its local API/site rehearsal servers. Database suites use real SQL and controlled provider fakes where noted. Record failing/skipped tests as well as passes. Do not substitute a source-pattern assertion for the production-sized concurrency, browser, provider or manual release gates.
