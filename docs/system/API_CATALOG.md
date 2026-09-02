# API Catalog (Curated)

This is the human + AI-friendly guide to the most important endpoints, what they do, and what auth they expect.

For a complete inventory of routes and handler files, see:

- `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`
- `StonegateOS/docs/system/API_ROUTE_INDEX_SITE.md`

---

## Auth model (high-level)

StonegateOS uses multiple “classes” of endpoints:

1. **Public endpoints (no auth)** — for the marketing/booking funnel and public assets.
2. **Admin endpoints (API key + permissions)** — used by the Team Console and internal automation.
3. **Partner endpoints (partner sessions)** — used by the partner portal UI under `/partners`.
4. **Provider webhooks** — Twilio/Meta/Email webhooks that ingest events.

### Admin API key gate

Many admin/business endpoints enforce `ADMIN_API_KEY` via `isAdminRequest`:

- Gate helper: `StonegateOS/apps/api/app/api/web/admin.ts`

### Role + permission gate (Team Console)

Most `/api/admin/*` routes also check permissions:

- Permissions helper: `StonegateOS/apps/api/src/lib/permissions.ts`

### Partner session gate

Partner portal endpoints require a partner session:

- Partner auth helper: `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`

Portal V2 authorization additionally requires an active global identity, an
operational selected account, and an active account membership resolved by
`partner-account-authorization.ts`. CRM contacts are downstream operational
projections, not authentication or tenant authority. Public verification,
activation, invitation, and reset endpoints consume purpose-bound credentials;
routine login is email/password with TOTP step-up where required.

Partner product telemetry is accepted through the existing public web-event
ingest, but the server independently recognizes every `/partners` surface and
every `partner_*` event. It removes query strings and opaque job/share IDs,
discards referrer, campaign, postal-code, and arbitrary metadata dimensions,
and rejects unknown Partner event names or funnel keys. Stable
`partner_funnel` keys contain only an allowlisted operational stage and
allowlisted persona. Raw events retain the existing 30-day limit; Staff reads
only aggregate daily counts.

`GET /api/admin/partner-management/v1/operations?rangeDays=7` requires
`partners.accounts.read`. It accepts only 1, 7, 14, or 30 days and returns
bounded aggregate availability, no-slot, contention, booking-completion,
abandonment, upload, and persona totals. Responses are private/no-store and
carry a support correlation ID. The endpoint never returns sessions, visits,
account/job IDs, addresses, notes, filenames, contacts, PO values, or billing
data.

Password authentication uses `POST /api/public/partners/login-password`. For
an MFA-required or already-enrolled identity, its `202 mfa_required` response
contains a five-minute pre-authentication bearer for the trusted Site adapter,
not a partner session. The adapter stores it only in a Secure, HttpOnly,
SameSite=Lax cookie and completes TOTP or single-use recovery verification via
`POST /api/public/partners/login-password/mfa`. Only that successful atomic
exchange returns an AAL2 partner session; the bearer is never accepted by
Portal V1/V2 session gates.

Sign-in-email changes use
`POST /api/portal/v2/security/email-change/request` from an authenticated,
recently assured settings session and
`POST /api/portal/v2/onboarding/email-change/confirm` with the new mailbox's
one-use 30-minute credential. Confirmation rotates the identity security
version, revokes all sessions and outstanding credentials, changes no CRM
record, and returns no login session.

Privileged activation uses the same containment boundary. After
`POST /api/portal/v2/onboarding/activation/complete` verifies the password, its
`202 mfa_setup_required` response contains only a ten-minute setup bearer for
the trusted Site adapter. The adapter stores it in a Secure, HttpOnly,
SameSite=Lax cookie. It calls
`POST /api/portal/v2/onboarding/activation/mfa/enrollment` to start a
transaction-bound TOTP enrollment (or discover an existing method), then
`POST /api/portal/v2/onboarding/activation/mfa/confirm` to verify TOTP or an
existing recovery code. Only confirmation atomically activates the target
identity/membership and returns an AAL2 session. Setup bearers are not accepted
by portal session middleware and never appear in browser URLs or client props.

Post-activation setup uses `GET /api/portal/v2/onboarding-checklist` and
`PATCH /api/portal/v2/onboarding-checklist`. The checklist is selected-account and
membership bound, stores only versioned progress/dismissal state in membership
preferences, and derives location, teammate, and proof readiness from canonical
account-owned records. Mutations require same-origin validation and
`If-Match`; stale progress returns `412`, and resource-backed steps cannot be
acknowledged before the underlying resource exists. The dashboard no longer
uses a `?setup=1` query parameter as account state.

Personal display-name settings use `GET /api/portal/v2/personal-profile` and
`PATCH /api/portal/v2/personal-profile`. Both resolve the selected active
Partner principal; the write revalidates and locks that exact
identity/account/membership binding in its transaction. `GET` returns only the
display name and its update timestamp with a strong,
account-and-membership-bound `ETag`. `PATCH` is same-origin checked, accepts a
strictly bounded 2–120 character name, requires the exact current `If-Match`,
and writes only `partner_users.name` plus an audit receipt in the same
transaction. It never updates or derives authority from a CRM contact. The
display name follows the global Partner identity across its eligible accounts.

Account organization and billing-contact settings use
`GET /api/portal/v2/account-profile` and
`PATCH /api/portal/v2/account-profile`. `GET` requires `account.read` and returns the
selected account's organization name/website, primary service contact, billing
contact/address, default PO/reference, cost-center guidance, view/edit permissions,
and a strong `ETag`. Billing fields are returned only with `commercial.edit` or
`invoices.read`; other account readers receive `billing: null`. It never returns CRM contact data, negotiated rates,
payment-provider identifiers, staff notes, or internal commercial terms.

`PATCH` is account-wide only, same-origin checked, strictly bounded, and
requires the exact current `If-Match`. Organization and service-contact fields
require `account.update`; billing fields require `commercial.edit`; a mixed
request requires both. An MFA-required membership must have satisfied MFA.
That verification must be AAL2 and no more than 15 minutes old. The account row
is locked, its independent profile revision is incremented,
and the field-section change receipt is audited in the same transaction. This
profile is booking guidance and correspondence data, not an authorization,
pricing, invoice, or provider-readiness source.

Account-specific Partner scheduling limits are persisted in
`partner_account_scheduling_policies` and managed through
`PATCH /api/admin/partner-management/v1/accounts/[accountId]/scheduling-policy`.
The Team mutation requires `partners.accounts.manage`, recent Team assurance,
same-origin validation, `Idempotency-Key`, the exact integer-revision
`If-Match`, a bounded reason, and the exact typed confirmation. It serializes
with the global scheduling advisory lock and commits the compare-and-swap
update, audit receipt, and idempotency receipt atomically. Effective Partner
policy is always `max(global notice, account notice)`, `max(global local-day
lead, account lead)`, `min(global horizon, account horizon)`, and
`global instant && account instant`. Account policy has no hours or capacity
inputs and therefore cannot widen either. A missing policy fails closed to
review instead of enabling instant confirmation.

Account-specific cancellation and schedule-change limits are persisted in
`partner_account_cancellation_policies`. An active selected-account Partner
principal with `bookings.create` may read the safe, current terms through
`GET /api/portal/v2/cancellation-policy`; the response is private/no-store and
includes a strong account/revision-bound `ETag`. Staff manage the record with
`PATCH /api/admin/partner-management/v1/accounts/[accountId]/cancellation-policy`.

That Team mutation requires `partners.accounts.manage`, recent Team assurance,
same-origin validation, `Idempotency-Key`, exact revision `If-Match`, a bounded
reason, and typed confirmation. Its compare-and-swap update, audit receipt, and
idempotency receipt commit together while holding the global scheduling lock.

Effective notice uses `max(Stonegate notice, account notice)` and direct
self-service eligibility uses `Stonegate direct && account direct`; an account
therefore cannot broaden Stonegate policy. Launch policy has a 24-hour minimum,
routes late confirmed-job cancellation and schedule-change requests to staff
review, and never applies a fee automatically. Cancellation loads the policy
inside its schedule-locked transaction. Rescheduling does the same: after the
cutoff, it releases the replacement hold into a durable review request while
leaving the existing appointment and promised arrival window unchanged. A
missing or invalid account policy fails closed to review.

Partner location verification and retained duplicate handling use:

- `POST /api/portal/v2/locations/validate`
- `POST /api/portal/v2/locations/[locationId]/merge`
- `POST /api/portal/v2/locations/[locationId]/restore`
- `GET /api/admin/partner-management/v1/location-reviews`
- `POST /api/admin/partner-management/v1/location-reviews/[reviewId]/decision`

Provider uncertainty and probable duplicates remain review-only; Staff
verification requires explicit coordinates and service-area evidence. Location
merge is same-account, non-destructive, and blocked by active dependencies.

Owner-controlled Partner account lifecycle and reconciliation use:

- `POST /api/admin/partner-management/v1/accounts/[accountId]/suspend`
- `POST /api/admin/partner-management/v1/accounts/[accountId]/reactivate`
- `POST /api/admin/partner-management/v1/accounts/[accountId]/close`
- `POST /api/admin/partner-management/v1/accounts/[accountId]/recover-administrator`
- `POST /api/admin/partner-management/v1/accounts/[accountId]/merge`
- `GET /api/admin/partner-management/v1/account-merges`
- `POST /api/admin/partner-management/v1/account-merges/[caseId]/complete`

Account merge is a bounded preflight and retained case, never an automatic
cross-tenant rewrite. Every mutation is idempotent, revision-gated, recently
authenticated, audited, and purpose-confirmed.

Canonical Partner commercial terms use
`GET/PATCH /api/admin/partner-management/v1/accounts/[accountId]/service-agreement`.
The Staff mutation requires `partners.commercial.manage`, recent Team MFA,
same-origin/CSRF validation, `Idempotency-Key`, strong `If-Match`, and a
bounded, duplicate-free service-entitlement body. `GET
/api/portal/v2/service-catalog` returns only services in the selected
account's active, effective agreement and includes the safe currency,
effective period, inclusions, exclusions, quote rules, and pricing state.
Missing, expired, malformed, or currency-inconsistent agreement/rate evidence
fails closed to review; a global catalog entry alone never grants entitlement
or instant confirmation.

Late or policy-blocked cancellation now creates exactly one durable,
account-owned `partner_cancellation_requests` row under the scheduling lock.
The immutable snapshot records the Partner-visible job/schedule and effective
no-automatic-fee policy; paired SHA-256 operation/request evidence provides
account-scoped replay protection. Partner job list/detail DTOs expose only the
safe pending request projection. Pre-0149 hash-only rows are placed in the
read-only cancellation reconciliation quarantine and never become actionable
requests or inferred decisions.

Staff use `GET /api/admin/partner-management/v1/cancellation-requests`,
`GET /api/admin/partner-management/v1/cancellation-requests/[requestId]`, and
`POST /api/admin/partner-management/v1/cancellation-requests/[requestId]/decision`.
Reads require `partners.cancellation_requests.read`. A decision requires
`partners.cancellation_requests.decide`, recent Team MFA, same-origin/CSRF
validation, `Idempotency-Key`, exact integer `If-Match`, a bounded reason, and
the decision-specific typed confirmation. Approval atomically cancels the
still-eligible appointment/job and supersedes both a pending reschedule and a
pending Partner job-change request; decline leaves the schedule intact and
clears the Partner-facing pending marker. The request CAS, public timeline
event, notification/outbox, Staff audit, and idempotency receipt commit
together. Resolved requests cannot be changed.

Partner invoice questions, disputes, and refund-review intake use
`GET/POST /api/portal/v2/invoices/[invoiceId]/dispute-requests`. The resource
first applies the canonical selected-account invoice-access predicate, so
foreign or out-of-scope invoices return opaque `404` before any request or
thread is exposed. `POST` requires `invoices.disputes.request`, Partner MFA
verified within 15 minutes, same-origin validation, `Idempotency-Key`, the
current invoice `If-Match`, and a bounded duplicate-key-rejecting body. The
cursor-paginated history creates one immutable pending request per
account/invoice and always links it to a deterministic, account-bound financial
billing thread. A related job remains immutable request linkage only; billing
evidence is never placed in the operational job thread. The operation never
changes invoice, allocation, payment, balance, or provider state.

Staff use `GET /api/admin/partner-management/v1/billing-disputes`,
`GET /api/admin/partner-management/v1/billing-disputes/[requestId]`, and
`POST /api/admin/partner-management/v1/billing-disputes/[requestId]/decision`.
Reads require `partners.billing_disputes.read`; decisions require the
Commercial Manager/Team Owner `partners.billing_disputes.decide` permission,
recent Team MFA, same-origin/CSRF validation, idempotency, exact revision CAS,
a bounded explanation, and outcome-specific typed confirmation. The immutable
outcomes are information provided, adjustment required, refund review, or
declined. They classify the next controlled workflow only: no automatic
adjustment or refund is issued. Requested/resolved delivery uses the durable
Partner notification ledger for in-app, email, and separately verified opt-in
SMS preferences. Partner and Staff alert outbox records carry only opaque IDs
and state labels, never the free-form request evidence.

Partner job-detail changes use two deliberately separate contracts introduced
with migration `0152_partner_job_change_requests`:

- `POST /api/portal/v2/jobs/[jobId]/change-requests` requires an active,
  selected-account principal with `jobs.change_request`, same-origin
  validation, `Idempotency-Key`, the current strong job `If-Match`, and a
  duplicate-key-rejecting bounded body. It stores one immutable pending request
  per account/job with the Partner's reason, prior public-field snapshot, and
  proposed description, crew-instruction, access-detail, or on-site-contact
  values. Price, schedule, service, quantity, hazard, and proof are declaration
  flags only; the request never changes those fields or promises acceptance.
  When Staff selects `change_order_required`, the decision must bind one exact,
  current, issued, unexpired, fixed-price Quote V2 for that same account and
  job. The immutable offer is exposed in the safe job/quote DTOs.
- `PATCH /api/portal/v2/jobs/[jobId]/references` requires `commercial.edit`
  and Partner MFA verified within the previous 15 minutes. It accepts only PO
  number, cost center, and project/reference fields, plus same-origin,
  idempotency, and strong `If-Match` guards. It updates the account-owned
  booking revision, public timeline, audit, and outbox atomically. It cannot
  change price, invoices, scope, service, schedule, or proof.

Both transactions acquire the global schedule advisory lock before the same
account/job advisory lock, revalidate the active membership and relational
location scope inside the transaction, use account/job compare-and-swap
writes, and return opaque `404` for foreign or out-of-scope jobs. An
idempotent create replay returns the request's actual current state, revision,
resolution timestamp, and the current booking revision/strong `ETag`; it does
not reconstruct the original pending response. Public DTOs expose only the
opaque job/change-request IDs, safe state, reason, revision, and
timestamps—never appointment or CRM-contact identifiers.

Staff manage job changes with
`GET /api/admin/partner-management/v1/change-requests`,
`GET /api/admin/partner-management/v1/change-requests/[requestId]`, and
`POST /api/admin/partner-management/v1/change-requests/[requestId]/decision`.
Reads require `partners.change_requests.read`; decisions require
`partners.change_requests.decide`, recent Team MFA, same-origin/CSRF
validation, `Idempotency-Key`, exact integer `If-Match`, a bounded reason, and
the outcome-specific typed confirmation. Approval may apply only the validated
public description/instruction/access/contact fields when their immutable
snapshot still matches. A declared or Staff-discovered material impact must
resolve as `change_order_required`, which changes no job field. Approval,
decline, and change-order routing are immutable and commit the request CAS,
booking revision, public timeline, Partner notification/outbox, Staff audit,
and idempotency receipt in one transaction. Accepting the bound Quote V2
atomically snapshots its exact amount/currency as the job's final commercial
price and applies only validated public scope fields; schedule, service, and
proof impacts remain explicitly pending Staff execution. Declining the quote
leaves the prior job price and scope intact. Both outcomes write public
timeline, notification, and outbox evidence. Decline or change-order routing
may close a legacy pending request after its job became terminal; approval may
not apply changes to a terminal job. Migration
`0155_partner_job_change_request_cancellation_resolution` adds the immutable
`superseded` outcome: direct Partner cancellation records exact system
provenance, while Staff-approved cancellation records the resolving Staff
actor. Either cancellation and supersession commit atomically under the same
global/account-job locks.

### Partner recurring-series lifecycle

- `GET /api/portal/v2/recurring-series`
  - Requires `bookings.read` and returns only series reachable through the
    selected account and relational location/property scope.
- `GET /api/portal/v2/recurring-series/[seriesId]`
  - Requires `bookings.read`; returns a private/no-store series projection and
    its strong `ETag`. Malformed, foreign-account, and out-of-scope IDs all
    return the same opaque `404`.
- `PATCH /api/portal/v2/recurring-series/[seriesId]`
  - Requires `bookings.update`, same-origin validation, `Idempotency-Key`, the
    exact strong `If-Match`, and a duplicate-key-rejecting JSON body no larger
    than 4 KiB: `{ "action": "pause|resume|cancel", "reason": "2–300 chars" }`.
  - Pause marks only future, unbooked tentative occurrences as visibly paused.
    Cancel marks only future, unbooked tentative/paused occurrences as
    canceled. Resume restores only lifecycle-paused, future, unbooked rows to
    tentative; it neither evaluates them immediately nor reserves capacity
    outside the 30-day horizon. Existing jobs, drafts, review outcomes, and
    confirmed occurrences are unchanged.
  - Lifecycle writes acquire the recurring-horizon claim lock, global schedule
    lock, and series advisory lock in that order. An occurrence already being
    evaluated returns a retryable `409`. Series/occurrence compare-and-swap
    writes, immutable audit evidence, canonical request hash, and the terminal
    replay receipt commit in one transaction; a retry returns the same stored
    post-state.

### Partner Quote V2 workspace

Quote V2 (`quotes`, `quote_versions`, and `quote_responses`) is the only quote
lifecycle authority. `partner_quotes` is an immutable account/target binding
and read projection. Rows marked `legacy_snapshot` remain visible for history
but are always non-actionable and must be reconciled by Stonegate before an
online response is possible.

- `GET /api/portal/v2/quotes`
  - Requires `quotes.read`. Returns a cursor-paginated selected-account list,
    filtered before pagination through relational location/property/cost-center
    scope. Status filters and cursors are bounded. Money is integer minor-unit
    data; raw Quote V2, opportunity, CRM, provider, and internal identifiers
    are not serialized.
- `GET /api/portal/v2/quotes/[partnerQuoteId]`
  - Requires `quotes.read`. Returns the sanitized current version, structured
    scope/pricing/options/terms, immutable response summary, version history,
    allowed actions, and a strong `ETag`. Malformed, foreign-account,
    out-of-scope, or corrupt bindings return the same opaque `404`.
- `GET /api/portal/v2/quotes/[partnerQuoteId]/document`
  - Requires `quotes.read`. Streams only the verified current proposal PDF
    after checking its stored byte size and SHA-256 digest. The response is
    private/no-store, uses a sanitized attachment filename, and records the
    canonical quote/version download evidence.
- `POST /api/portal/v2/quotes/[partnerQuoteId]/decision`
  - Requires `quotes.respond`, AAL2 Partner MFA verified in the previous 15
    minutes, same-origin validation, `Idempotency-Key`, the exact strong
    `If-Match`, and a duplicate-key-rejecting body no larger than 8 KiB.
    Acceptance requires explicit signer authority, consent to the exact
    proposal version, valid option selections, intact issued-PDF evidence, and
    any account approval for the same target, currency, and exact accepted
    amount. Decline requires a bounded reason category and optional notes.
  - Public-capability, Team, and Partner responses use one terminal-decision
    transaction. Exactly one response can win the version/aggregate CAS; it
    atomically updates the opportunity, writes immutable actor/request
    evidence, and queues the response outbox event. An identical replay
    returns the original post-state and terminal `ETag`; changed payloads or
    competing actors receive a safe conflict.

Staff begin an account-bound quote with
`GET /api/admin/partner-management/v1/accounts/[accountId]/quote-context`.
The read requires both `partners.commercial.read` and `quotes.write` and
returns only explicit active Partner-location, account-owned CRM-contact, and
property tuples. The Team Quote V2 create contract accepts that verified
`partnerContext`; creation writes the canonical quote and immutable
`partner_quotes` binding in the same transaction. Partial, stale, ambiguous,
or forged context fails closed instead of creating an unbound Partner quote.

### Partner administration security

- `GET /api/admin/partner-management/v1/security`
  - Permission: `partners.security.read`.
  - Purpose: cursor-paginated Partner session inventory with `active`,
    `expired`, and `revoked` filters plus bounded person/company/device search.
  - Optional filters: `accountId` and `userId`. Cursors are bound to the full
    filter set.
  - Returns identity, selected-account, membership, role, device label,
    assurance, and lifecycle timestamps. It never returns the session hash,
    bearer credential, security version, IP address, or raw user-agent string.

- `POST /api/admin/partner-management/v1/security/sessions/[sessionId]/revoke`
  - Permission: `partners.security.sessions.revoke`.
  - Purpose: revoke exactly one active Partner session. It does not suspend a
    membership or disable the global identity.
  - Requires recent Team TOTP assurance and sign-in, same-origin validation,
    `Idempotency-Key`, `If-Match`, an account/user/membership-bound target,
    a bounded reason, and the exact `REVOKE PARTNER SESSION` confirmation.
  - The session change, success audit receipt, and idempotency receipt commit
    atomically. A stale session revision returns `412` and requires refresh.

- `GET /api/admin/partner-management/v1/security/identities/[userId]`
  - Owner-only permission: `partners.identities.disable`.
  - Purpose: load the bounded, safe impact review required before a global
    identity action. It enumerates every account membership (maximum 250),
    identity/MFA posture, active-session count, and a membership snapshot.
  - It returns no credential, TOTP secret, recovery-code digest, session hash,
    provider payload, network fingerprint, job detail, or financial detail. If
    the complete membership set cannot be enumerated, both global mutations
    fail closed.

- `POST /api/admin/partner-management/v1/security/identities/[userId]/disable`
  - Owner-only permission: `partners.identities.disable`.
  - Purpose: disable one global partner identity across all of its companies.
  - Requires recent Team TOTP, same-origin validation, `Idempotency-Key`, the
    exact identity `If-Match`, the reviewed membership snapshot, a 20–1000
    character reason, and `DISABLE [email]` typed exactly.
  - Atomically sets the identity to `disabled`, increments its security
    version, revokes every partner session and pending credential, and records
    the audit/idempotency receipts. Account memberships remain unchanged, and
    account, job, document, payment, and financial records are preserved.

- `POST /api/admin/partner-management/v1/security/identities/[userId]/mfa/reset`
  - Owner-only permission: `partners.security.mfa.reset`.
  - Purpose: revoke all MFA authenticators/recovery codes and require secure
    re-enrollment without suspending or activating any membership.
  - Requires recent Team TOTP, same-origin validation, `Idempotency-Key`, the
    exact identity `If-Match`, membership snapshot, reason, and
    `RESET [email] MFA` typed exactly. The identity must remain active, have an
    existing password, and have an active portal-enabled recovery membership.
  - Atomically revokes sessions and pending credentials, clears stored
    authenticator secret/reference material, invalidates recovery codes,
    increments the security version, and queues a one-use purpose-bound
    activation challenge. No raw token is returned. The activation path first
    verifies the existing password, then requires transaction-bound TOTP
    enrollment before it creates an AAL2 session. Repeating a pending recovery
    revokes the earlier link and queues a new security-version-bound challenge.

- `GET /api/admin/partner-management/v1/quarantine`
  - Permission: `partners.quarantine.read`.
  - Purpose: cursor-paginated, filter-bound inventory of contained identities,
    quarantined migrated memberships, and legacy invitation/access-link
    delivery anomalies.
  - Status filters are `contained`, `reconciliation_required`, and `resolved`;
    bounded search plus account/user filters are supported. Cases expose safe
    reason codes and lifecycle history, never credential hashes, provider
    request keys, raw provider payloads, IPs, or user agents.
  - Identity and migrated-membership cases are read-only because their current
    records do not contain a safe reversible release lifecycle.

- `POST /api/admin/partner-management/v1/quarantine/[caseId]/resolve`
  - Owner-only permission: `partners.quarantine.release`.
  - Purpose: record conclusive provider evidence for an unresolved legacy
    invitation/access-link delivery and release its duplicate-send guard.
  - Requires recent Team TOTP and sign-in, `Idempotency-Key`, `If-Match`, every
    requested channel, evidence type, provider IDs for a confirmed send, a
    bounded reason, and an outcome-specific typed confirmation.
  - The endpoint never calls or retries a provider. It preserves original
    provider evidence and atomically commits the resolution, audit, and
    idempotency receipt. Confirmed non-send also invalidates unused legacy
    access tokens defensively.

### Partner administration commercial readiness

- `GET /api/admin/partner-management/v1/commercial`
  - Permission: `partners.commercial.read`.
  - Purpose: cursor-paginated, account-scoped readiness inventory for the
    operational rate-card projection, versioned rate-card records, approval
    rules/requests, quotes, invoices, balances, hosted-invoice gaps, and
    pending payment allocations.
  - Status filters are `ready`, `attention_required`, and `unconfigured`;
    bounded company/domain search and an exact `accountId` filter are
    supported. Cursors are bound to the full filter set.
  - Returns integer minor-unit balances only when safely representable. It
    never returns hosted payment URLs, provider invoice/order identifiers,
    provider payloads or credentials, internal margins, commissions, or
    staff-only adjustments.
  - The readiness inventory is read-only. Approval rules are managed only
    through the account-scoped resources below; account billing-policy,
    provider-readiness, and legacy contact-oriented negotiated-rate writes
    remain unavailable. No payment/provider mutation is exposed here.

- `GET /api/admin/partner-management/v1/accounts/[accountId]/approval-rules`
  - Permission: `partners.commercial.read`.
  - Purpose: cursor-paginated account-owned approval rules plus bounded active
    service/location selectors. `includeInactive=true|false` is filter-bound
    into the cursor. Foreign or missing accounts return an opaque `404`.
  - Returns fixed `approvals.decide` authority, revision/ETag, and sanitized
    creator provenance. It never returns approval-request evidence or permits
    rule authority to be configured from a role-name string.

- `POST /api/admin/partner-management/v1/accounts/[accountId]/approval-rules`
  - Permission: `partners.commercial.manage`.
  - Purpose: create one canonical account approval rule. All matching active
    rules apply and no more than 50 may be active for an account.
  - Requires a human Team principal, recent financial-grade Team assurance,
    same-origin validation, `Idempotency-Key`, a duplicate-key-rejecting body
    no larger than 16 KiB, a 12–1000 character operational reason, and exact
    `CREATE APPROVAL RULE` confirmation. The account lock, Team provenance,
    success audit, and replay receipt commit atomically.

- `GET /api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]`
  - Permission: `partners.commercial.read`.
  - Purpose: load one account-bound rule and its exact strong integer-revision
    `ETag`. Malformed, missing, and cross-account substitutions are the same
    opaque `404`.

- `PATCH /api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]`
  - Permission: `partners.commercial.manage`.
  - Purpose: revision-safely revise, activate, or deactivate a rule. There is
    no hard-delete route.
  - Requires the same mutation boundary as create plus exact integer
    `If-Match` and `UPDATE APPROVAL RULE` confirmation. Service and location
    selectors are revalidated under the account lock. A stale revision fails
    without overwriting the winning configuration.
  - Rule changes affect only future evaluations. Approval requests retain
    immutable captured rule/request evidence, including after deactivation.

### Partner location portfolio

- `GET /api/portal/v2/locations`
  - Capability: `properties.read`.
  - Purpose: bounded search and cursor pagination over only the selected
    account membership's permitted locations. Results carry personal favorite,
    account-default, safe hierarchy, child-count, location revision, and
    directory revision metadata. Scoped memberships do not receive hidden
    hierarchy/default identifiers.

- `POST /api/portal/v2/locations`
  - Capability: `properties.manage` with account-wide location access.
  - Purpose: create an explicitly account-owned location, optionally under an
    active same-account parent or as the account default. The account directory
    lock, exact duplicate scan, property projection, location, default update,
    directory CAS, and audit commit atomically.
  - Requires same origin, duplicate-key-rejecting JSON no larger than 16 KiB,
    and `Idempotency-Key`. Exact address/property-ID duplicates return `409` and
    are never silently merged. V2 never derives authority from a CRM contact.

- `GET /api/portal/v2/locations/[locationId]`
  - Capability: `properties.read`; location scopes are enforced in the query.
  - Purpose: return one sanitized account location and strong location `ETag`.
    Missing, foreign-account, and same-account out-of-scope IDs all return the
    same opaque `404`.

- `PATCH /api/portal/v2/locations/[locationId]`
  - Capability: `properties.manage`; parent/default changes additionally
    require account-wide location access.
  - Purpose: revision-safe updates, reactivation, hierarchy changes, and
    default selection. It requires same origin, bounded duplicate-safe JSON,
    `Idempotency-Key`, and exact `If-Match`; all writes run under the account
    directory lock and increment its CAS revision. `active=false` is rejected
    here so callers cannot bypass impact-aware archive.

- `GET /api/portal/v2/locations/[locationId]/archive-impact`
  - Capability: `properties.manage` plus location scope.
  - Purpose: report default/child/draft/template/job impact plus active and
    issued-actionable canonical Quote V2 bindings immediately before archive.
    It is advisory; `DELETE` recomputes the impact under the directory and
    location locks.

- `DELETE /api/portal/v2/locations/[locationId]`
  - Capability: `properties.manage` plus location scope.
  - Purpose: recoverably archive a location without deleting job history. The
    bounded body requires a reason and exact `ARCHIVE LOCATION`; default sites
    require a valid active replacement, and active children must be promoted
    or moved to a valid same-account parent. Default reassignment and child
    moves occur before archive in one deferred-constraint transaction.
    Issued, unexpired, unanswered Quote V2 proposals block archive until they
    are resolved, expired, superseded, or voided. Once archive is allowed,
    existing scoped quote/document evidence remains readable and downloadable,
    while new quote responses and new direct/draft quote issue are denied.
  - Requires same origin, `Idempotency-Key`, and exact location `If-Match`.

- `PUT /api/portal/v2/locations/[locationId]/favorite`
  - Capability: `properties.read` plus location scope.
  - Purpose: set or clear a membership-private favorite. Requires same origin,
    bounded duplicate-safe JSON, `Idempotency-Key`, and location `If-Match`.
    Composite foreign keys prevent membership/location tenant substitution.

- `GET /api/portal/v2/locations/export`
  - Capability: `reports.operational.export` plus location scope.
  - Purpose: audited CSV export of up to 1,000 visible account locations. Cells
    are spreadsheet-formula escaped. Gate codes, access instructions, contacts,
    and other secrets are never columns or analytics inputs.

- `POST /api/portal/v2/locations/imports/dry-run`
  - Capability: `properties.manage` with account-wide location access.
  - Purpose: parse and snapshot a 1–500-row, at-most-256-KiB CSV for 30 minutes,
    returning row-level errors and an immutable correction artifact without
    creating any locations. Headers are strict; secret-bearing/unknown columns,
    overlong values, non-two-letter state values, duplicates, missing/inactive
    parents, and cycles fail validation. Values are validated in full and are
    never silently truncated or coerced.
  - Requires same origin, bounded duplicate-safe JSON and `Idempotency-Key`.
    Only normalized operational rows, safe validation evidence, request hashes,
    and membership provenance are retained; raw CSV is not stored.

- `GET /api/portal/v2/locations/imports/[importId]`
  - Capability: `properties.manage` with account-wide location access.
  - Purpose: retrieve the account-bound dry-run evidence and import `ETag`.

- `GET /api/portal/v2/locations/imports/[importId]/corrections`
  - Capability: `properties.manage` with account-wide location access.
  - Purpose: audited, no-store correction CSV containing every row and safe
    field error. Foreign or expired/purged identifiers remain opaque.

- `POST /api/portal/v2/locations/imports/[importId]/commit`
  - Capability: `properties.manage` with account-wide location access.
  - Purpose: revalidate and atomically create every validated row in parent-
    before-child order, or create none. It requires exact
    `IMPORT N LOCATIONS`, same origin, bounded duplicate-safe JSON,
    `Idempotency-Key`, and the current directory `If-Match` returned as
    `X-Location-Directory-ETag` by dry-run. A changed directory, duplicate,
    expired operation, missing parent, stale revision, or mismatch between the
    retained source evidence and normalized rows fails closed.

Import evidence expires after 30 minutes and is eligible for bounded purge
after seven days. `prune_partner_location_imports(prune_at, prune_limit)` marks
expired operations and deletes at most the requested 1–5,000 eligible rows per
call. Migration `0154_partner_location_portfolio_controls` owns these portfolio
constraints and cleanup semantics.

---

## Public booking/quote funnel APIs

### Junk removal

- `POST /api/junk-quote`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/route.ts`
  - Purpose: create/update contact + lead + instant quote and return a **price range**.

- `POST /api/junk-quote/availability`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/availability/route.ts`
  - Purpose: compute available booking slots for a given `instantQuoteId` + address.

- `POST /api/junk-quote/hold`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/hold/route.ts`
  - Purpose: place a short hold on a selected slot to reduce booking races.

- `POST /api/junk-quote/book`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/book/route.ts`
  - Purpose: create an `appointments` row (self-serve booking) and enqueue confirmations/alerts.

- `POST /api/public/junk-quote/uploads`
  - Handler: `StonegateOS/apps/api/app/api/public/junk-quote/uploads/route.ts`
  - Purpose: accept 1–4 images from the public site and return signed URLs accessible to Twilio.

### Brush clearing

- `POST /api/brush-quote`
  - Handler: `StonegateOS/apps/api/app/api/brush-quote/route.ts`
  - Purpose: create lead + instant quote range for brush.
  - Booking still uses the shared `/api/junk-quote/availability|hold|book` endpoints.

### Demolition

- `POST /api/demo-quote`
  - Handler: `StonegateOS/apps/api/app/api/demo-quote/route.ts`
  - Purpose: create lead + demo estimate range.
  - Booking still uses the shared `/api/junk-quote/availability|hold|book` endpoints.

### Public quote links

- `GET /api/public/quotes/[token]`
  - Handler: `StonegateOS/apps/api/app/api/public/quotes/[token]/route.ts`
  - Purpose: view quote details via a shareable token.

---

## Public analytics ingestion

- `POST /api/public/web-events`
  - Handler: `StonegateOS/apps/api/app/api/public/web-events/route.ts`
  - Purpose: first-party web analytics events (used for `/book*` funnel dashboards).
  - Writes: `web_events`, `web_event_counts_daily`, `web_vitals` (prunes raw after 30 days).

---

## Webhooks (provider ingress)

### Twilio

Directory: `StonegateOS/apps/api/app/api/webhooks/twilio`

- SMS webhook: `POST /api/webhooks/twilio/sms`
- Voice “missed call” logger: `POST /api/webhooks/twilio/voice`
- Call status callback: `POST /api/webhooks/twilio/call-status`
- Outbound call connect TwiML: `GET/POST /api/webhooks/twilio/connect`
- Sales escalation TwiML: `GET/POST /api/webhooks/twilio/escalate`

Important:

- Inbound call _blocking/screening_ requires Twilio to route “A call comes in” to a TwiML endpoint that can `<Reject/>`.
  The current inbound voice endpoints are primarily for **logging/status**.

### Meta (Facebook)

- `POST /api/webhooks/facebook`
  - Handler: `StonegateOS/apps/api/app/api/webhooks/facebook/route.ts`
  - Purpose: lead ads + Messenger message ingest.

### Email / DM

- `POST /api/webhooks/email`
- `POST /api/webhooks/dm`

---

## Admin APIs used by Team Console

Admin endpoints live under:

- `StonegateOS/apps/api/app/api/admin`

They cover:

- Contacts, properties, pipeline, tasks/reminders
- Inbox threads/messages, uploads, exports
- Calls/coaching, booking assistant, calendar feeds
- Expenses + receipts
- Policy + automation settings
- Partners: users, rates, bookings
- Marketing: Google Ads sync + analyst reports + recommendations, Meta insights sync

See the complete inventory:

- `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`
