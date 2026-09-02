# Partner Portal single-cutover runbook

- Owner: Stonegate Team Owner and release commander
- Scope: the one production cutover from legacy partner access to canonical
  account memberships and Portal V2
- Rollback posture: preserve accepted work and financial records; disable unsafe
  features or enter maintenance/review-only mode; never restore CRM-contact
  authorization or routine magic-link login
- Last updated: 2026-09-01

## Release authority

The external release is global. Selected production partners are not used as a
canary cohort. Before the switch, validation uses staging, production-safe
shadow comparisons, provider sandboxes, and Stonegate-owned internal accounts.
After the switch, all eligible partner accounts use the same identity,
authorization, and API path.

The release commander records every decision, operator, UTC timestamp, deployed
revision, migration revision, configuration digest, and correlation ID in the
cutover record. A failed gate stops the cutover; it is never silently waived.

## Required preflight evidence

Do not schedule the switch until all of these are attached to the release:

1. The 99-finding audit ledger has no unresolved P0-P3 row and each row contains
   implementation, automated, manual, operational, and superseding-decision
   evidence as applicable.
2. A fresh PostgreSQL 16 database applies every migration and seeds all four
   roles, every persona, multi-account users, restricted scopes, privileged MFA,
   billing states, and representative job states.
3. A production-sized snapshot rehearsal completes normalization, backfill,
   quarantine, privileged-membership review, restore, and global flag switching
   within the approved maintenance window.
4. Every migrated privileged membership is explicitly reviewed. No ambiguous
   tenant, domain, identity, contact, invitation, role, or scope mapping remains
   outside quarantine.
5. Shadow comparison shows no unexplained identity, authorization,
   availability, status, or price difference. Expected differences are linked
   to a signed product decision.
6. The production-equivalent concurrency suite shows no double booking, hold
   over-consumption, invitation race, or duplicate approval/payment effect.
7. Square, email, verified opt-in SMS, object storage, Mapbox, and Google
   Calendar pass sandbox certification. A Stonegate-owned production smoke plan
   and reversal/reconciliation owner are named for each provider.
8. WCAG 2.2 AA manual checks, the required browser/device matrix, 200%/400%
   zoom, failure drills, and representative usability tests meet the acceptance
   criteria.
9. Staff training and the access, scheduling, media, notification, payment,
   provider-reconciliation, and rollback runbooks are acknowledged.

## Configuration preflight

Record values without copying secrets into the cutover log. Confirm:

- Portal V2 reads and writes can be switched independently.
- Purpose-bound verification, activation, invitation, and reset credentials are
  enabled, while routine portal magic login is explicitly disabled and absent
  from the UI.
- `PARTNER_PORTAL_INTERNAL_TEST_MODE` is disabled and
  `PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS` is empty in production.
- Instant confirmation, hosted payments, embedded payments, external email,
  verified opt-in SMS, and recurring evaluation begin disabled unless their
  individual production gates have already passed.
- API and worker services share the same provider kill-switch values.
- Password hashing, session-cookie, CSRF/origin, HTTPS, CSP, email, SMS,
  Calendar, Mapbox, storage, and Square production configuration is present.
- Database backups, point-in-time recovery, monitoring, and the read-only or
  maintenance response are verified before any session revocation.

## Cutover sequence

1. Announce the maintenance window and freeze legacy partner-authority writes.
2. Capture the final backup, application revision, database revision, worker
   state, outbox age, provider webhook lag, and legacy/V2 comparison counts.
3. Apply expand-only migrations. Run migration assertions before proceeding.
4. Normalize identities, backfill only explicit account relationships, apply
   reviewed role/scope mappings, and leave every ambiguous record quarantined.
5. Revoke legacy partner sessions, login tokens, and stale invitation
   generations. Do not revoke purpose-bound credentials created by the new flow.
6. Enable canonical password authentication, account memberships, V2 reads, and
   V2 writes globally. Keep routine magic login and contact-derived authority
   disabled.
7. Run Stonegate-owned production smoke journeys: password plus MFA login,
   account switch, standard booking, review-only request, reschedule,
   cancellation, proof upload/package, message, approval separation, invoice
   read, hosted payment link, embedded payment, report export, and staff preview.
8. Reconcile every smoke-side appointment, hold, audit, outbox, provider,
   document, payment, and notification record before enabling external delivery
   or instant confirmation.
9. Open global partner traffic. Observe the high-signal checks below through the
   full maintenance/observation window.

## Go/no-go checks

Abort or enter safe maintenance mode immediately for any of the following:

- Cross-account or out-of-scope data is returned.
- A session is issued for an inactive identity, ineligible account, or absent
  membership, or an MFA-pending transaction reaches a portal API.
- A phone number authenticates a user or routine magic login succeeds.
- A migrated privileged membership was not reviewed.
- Any scheduling writer bypasses the canonical lock/capacity transaction, or a
  stale dependency produces an instant confirmation.
- A booking promise, proof package, invoice balance, payment allocation, or
  notification delivery state cannot be reconciled.
- Provider/webhook lag, outbox age, upload failure, or calendar freshness
  exceeds the documented safe threshold without review-only degradation.

## Safe rollback

Rollback never restores legacy authorization. Apply the narrowest response:

1. Disable instant confirmation and recurring evaluation; preserve review
   intake if writes remain safe.
2. Disable embedded/hosted payment initiation and external notification
   dispatch independently when those providers are affected.
3. Disable V2 writes and present read-only/maintenance behavior while retaining
   accepted bookings, messages, documents, proof, invoices, and payment records.
4. Disable V2 reads only for suspected tenant or serialization exposure.
5. Stop affected workers before changing queued records. Inspect and reconcile
   indeterminate operations rather than retrying them blindly.
6. Restore application code only when it continues to use canonical identities,
   memberships, account scopes, and purpose-bound credentials against the
   expanded schema.

Before service returns, reconcile all records created around the incident,
repeat the failed gate with Stonegate-owned accounts, record the remediation and
evidence in the audit ledger, and obtain a new global go/no-go decision.

## Observation and closure

During cutover, alert on tenant-safe authorization failures, authentication and
MFA error rate, calendar freshness, availability latency, hold conflicts,
schedule mismatches, outbox age, notification failures, webhook lag, payment
allocation, uploads, and recurring-work failures. Product analytics must remain
first-party and contain no addresses, notes, contacts, filenames, PO values,
gate codes, account/member IDs, or billing data.

Close the cutover only after the observation window has no unexplained tenant
leak, double booking, payment discrepancy, silent notification loss, or legacy
authorization request, and every production smoke operation has a documented
reconciliation result.
