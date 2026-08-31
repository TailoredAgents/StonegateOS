# Professional Quotes V2 operations and support runbook

Owner: Sales Operations with Engineering on-call  
Applies to: Quote V2 staff workspace, sender, customer proposal, response, deposit, and booking  
Last reviewed: 2026-08-30

## Safety posture

Quote V2 is an immutable evidence system. Recovery must preserve the exact
issued version, signer response, payment, and appointment records. Never edit an
issued version, delete conversion evidence, paste a public customer URL into an
internal alert, or manually mark a payment captured from the browser return.

The operational snapshot is available to authenticated staff with
`quotes.read` at:

```text
GET /api/admin/quotes/v2/operations?lookbackDays=7
```

It is `no-store` and returns aggregate counts only. It deliberately excludes
customer names, contact data, addresses, capability hashes, provider payloads,
and object-storage keys. Review it at the start of each business day and during
every Quote incident. Critical alerts are zero-tolerance; warnings require
same-business-day ownership.

## Public abuse-control configuration

Before enabling the public Quote V2 cohort, configure these variables on both
the `stonegate-site` and `stonegate-api` Render services:

- `QUOTE_RATE_LIMIT_HMAC_SECRET`: the same independent random value of at least
  32 characters on both services. It HMACs candidate tokens and client network
  classes before a durable counter is written.
- `QUOTE_PUBLIC_PROXY_SHARED_SECRET`: a second, same-on-both-services random
  value of at least 32 characters. It authenticates the privacy-preserving
  site-to-API network header and must not equal the rate-limit secret.
- `QUOTE_PUBLIC_TRUSTED_PROXY_HOPS=1`: Render contributes one trusted hop. Both
  services select the right-most trusted `X-Forwarded-For` entry, so a caller's
  prepended header cannot choose a new bucket.

Rotate the two secrets independently through Render's secret store. Deploy the
site and API together during rotation; a signature mismatch fails closed with
`503` and never falls back to a caller-supplied forwarding header. The site
forwards only an authenticated HMAC of the `/24` IPv4 or `/64` IPv6 class—never
the address or forwarding chain. Direct unsigned API requests use the declared
trusted-hop path when configured and otherwise share a bounded
`unknown-direct` network bucket.

Every public proposal, engagement, change, response, availability, hold,
checkout, booking, PDF, and attachment request consumes the network counter
before the candidate-token counter and before capability lookup. A `429`
includes `Retry-After`. If a token-spray incident is suspected, confirm that
the relevant `<scope>:network` row increases while new
`<scope>:candidate_token` rows stop appearing after the network block. Never
copy a raw capability or client address into incident notes.

The existing `quote-v2-engagement-retention --execute` maintenance run also
deletes rate-limit windows in bounded batches. It keeps rows for at least 48
hours and additionally refuses to delete any row whose `blocked_until` is not
older than that cutoff, which is conservative relative to the enforced
24-hour maximum window/block duration. Continue the job while
`rateLimitBatchMayHaveMore` is true.

## First response

1. Record the operational alert code, correlation ID, time range, affected
   quote/version/attempt IDs, and current feature-flag state. Do not record raw
   capability tokens or customer PII in the incident channel.
2. If customer evidence, money, or capacity may be wrong, disable only the
   narrowest affected cohort flag (`sender`, `mutations`, `deposits`, or
   `booking`). Already issued V2 links must remain readable.
3. Preserve outbox, provider, document, response, payment, and appointment
   records. Retry idempotently through the existing command; do not recreate the
   quote or issue a replacement version merely to clear an operational error.
4. Reconcile from authoritative records in this order: immutable quote version
   → response evidence → verified provider record → appointment.
5. Attach the resolution and evidence IDs to the incident and confirm the alert
   returns to zero. A dashboard becoming green without explaining the affected
   records is not closure.

## Zero-tolerance alerts

### Raw capability disclosure

Alert: `quote_v2_raw_capability_disclosure`

- Disable new capability issuance and sender rollout for the affected cohort.
- Revoke the exposed signer capability; use **Replace customer link** to create
  one new action-capable link. The old link becomes read-only or revoked.
- A revoked, read-expired, superseded, or deleted-contact capability cannot
  recover an earlier mutation receipt with a captured idempotency key. Replays
  are authorized against the original capability before evidence is returned.
- Search logs, analytics, outbox payloads, alerts, conversation bodies, and
  support records by correlation/quote ID—not by pasting the token.
- Notify Security and complete secret-exposure review before re-enabling send.

### Acceptance evidence

Alert: `quote_v2_acceptance_evidence_missing`

- Pause customer mutations for the cohort.
- Do not infer signer consent or reconstruct hashes after the fact.
- Preserve the response and proposal documents; classify the acceptance as
  incomplete evidence and route it to Sales Operations/Legal for a fresh,
  explicit version-bound response if needed.

### Value mismatch

Alert: `quote_v2_total_mismatch`

- Disable deposits and booking for the affected cohort.
- Compare accepted min/max/deposit/configuration/content hashes against the
  appointment and verified payment ledger.
- Never change an issued version or acceptance snapshot to match a provider.
- If money captured differs from the accepted deposit, follow the Square
  reconciliation runbook and create a refund/rebook review task.

### Duplicate conversion

Alert: `quote_v2_duplicate_terminal_state`

- Stop the affected mutation immediately.
- Preserve both records, identify the idempotency/concurrency path, and assign a
  human reconciliation owner. Do not delete a payment or appointment.
- Confirm database uniqueness constraints and the command's replay receipt
  before rollout resumes.

### Change request SLA

Alerts: `quote_v2_change_without_task`, `quote_v2_change_sla_overdue`

- Every open versioned request must have exactly one owner task and due time.
- Assign unowned work to the quote owner; otherwise use the configured sales
  queue. The due time is four business hours in the configured business zone.
- While open, acceptance, decline, holds, checkout, booking, and opportunity
  automation remain paused for the whole quote.
- Resolve by publishing a revision or explicitly reopening the unchanged,
  unexpired version. An expired version always requires revision/reissue.

An eligible expired proposal shows its designated signer **Request updated
proposal**. The command binds the exact current and published version, keeps
that version expired/read-only, and creates one `expired_refresh` change
request plus one owner task due in four business hours. Replays return the
original receipt. Staff must resolve it by publishing and issuing a revision;
never reopen the expired version. Viewer links and superseded, declined,
voided, terminal-response, closed-opportunity, or already-requested proposals
must remain read-only.

### Outbox and quarantine

Alerts: `quote_v2_unknown_event`, `quote_v2_outbox_quarantine`

- Unknown `quote.*` events must remain quarantined; never mark them processed.
- Validate schema version and ID-only payload shape. Quote event payloads must
  not contain names, contact data, messages, URLs, or tokens.
- Retry supported events only after the failing step is safe to replay. Verify
  step-level receipts and exact notification counts before release.

### Closed opportunity regression

Alert: `quote_v2_closed_opportunity_regression`

- Freeze automation for the opportunity.
- Reconcile its CAS revision and event order. `accepted`, `won`, and `lost`
  states must never move backward from delayed send/payment/booking work.
- Correct through the opportunity command service with an audit reason, never
  with a direct contact-wide pipeline update.

### Orphaned evidence

Alert: `quote_v2_orphaned_document_or_pointer`

- Pause issuing for the affected cohort.
- For a pointer mismatch, preserve both aggregates and restore the pointer only
  through a transaction that proves version ownership.
- For a native issued version without its proposal PDF, attempt deterministic
  regeneration only if the canonical render JSON and hashes verify. Otherwise
  keep the version unavailable for action and escalate; do not fabricate an
  issued artifact.

## Recoverable warnings

### Delivery recovery

Alert: `quote_v2_delivery_failure`

- Inspect the immutable send attempt and each delivery receipt.
- Retry only the failed channel against the same version and recipient. A
  recipient or customer-visible content change requires a new send attempt; a
  proposal content or expiry change requires a new revision.
- `Partial` and `Reconciliation required` remain visible until every requested
  channel has a terminal, explained state.

### Hold recovery

Alert: `quote_v2_expired_active_hold`

- Release the expired hold idempotently and confirm no appointment consumed it.
- Keep an accepted response accepted. Offer a new slot or staff follow-up; do
  not claim the previous slot was booked.
- If payment captured after expiry, follow the late-capture procedure in the
  Square runbook.

### Contact lifecycle and DNC

- A soft-deleted contact is inactive for Quote V2 scheduling. Availability,
  hold, and booking checks revoke every capability for that quote and return a
  gone response; do not restore the old link after undelete—issue a new link
  only after staff has revalidated the client and proposal.
- Do-not-contact governs outbound communication and does not block a customer
  who voluntarily uses an already issued proposal to view, approve, pay, or
  schedule. The combined booking confirmation is suppressed and the workflow
  records `do_not_contact` as the reason. Staff must not manually resend it
  without a documented contact-preference change.
- If deletion or DNC changes during a booking race, preserve any committed
  acceptance/payment/appointment evidence and route follow-up to staff; never
  erase the conversion record.

## Customer support state guide

| State                                             | What staff should say/do                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Expired · update available                        | The exact old proposal remains read-only. Ask the signer to use **Request updated proposal**; the assigned owner prepares a revision. |
| Superseded/declined/voided                        | The exact proposal remains readable during its retention period, but actions are closed. Create a staff revision when appropriate.    |
| Changes requested                                 | Confirm the request is assigned and quote the due time. Do not ask the customer to approve the old proposal.                          |
| Accepted · Deposit due                            | Acceptance is preserved. Help resume or replace the checkout; do not request a second acceptance.                                     |
| Deposit received · Scheduling confirmation needed | Acknowledge receipt, assign the urgent rebook/refund task, and do not promise the expired slot.                                       |
| Booked                                            | Use the appointment bound to the accepted response; send one combined confirmation.                                                   |
| Booked · DNC                                      | Keep the appointment and evidence, but do not send an outbound confirmation until the contact preference is explicitly changed.       |
| Availability unavailable                          | Explain that scheduling could not be checked. Offer explicit staff follow-up without describing it as no capacity.                    |
| No availability                                   | Explain that the checked window has no openings and offer staff follow-up or a later date expansion.                                  |

## Daily and release checks

- Critical operational alert counts are all zero.
- Overdue change requests, delivery failures, expired active holds, payment
  reconciliation, and quarantined events have named owners.
- Create-to-issue, delivery, response, deposit, and booking counts show no
  unexplained funnel discontinuity.
- Browser-confirmed visible proposal views and PDF downloads reconcile with
  delivery volume; ordinary GETs and link scanners are not counted as views.
- Migration review items and shadow-read discrepancies are dispositioned.
- Provider health, PDF latency, list/search latency, and public Web Vitals meet
  the release thresholds.
- Capability secret scan, axe matrix, browser journeys, and Square reconciliation
  evidence are attached to the release record.

## Engagement retention maintenance

Run `corepack pnpm quote-v2:engagement-retention` at least daily. The job takes
a transaction-scoped advisory lock, aggregates at most 5,000 detailed visible
proposal events older than 90 days into identifier-free UTC daily buckets, then
deletes those exact source rows in the same transaction. It also deletes at
most 5,000 expired public quote mutation receipts.

- A `skipped_locked` result is healthy when another invocation is active.
- Repeat promptly while either `engagementBatchMayHaveMore` or
  `receiptBatchMayHaveMore` is true.
- Alert when the job fails or when either backlog flag remains true after the
  scheduled catch-up window.
- Output is aggregate-only. Never add quote, contact, capability, token,
  network, or browser identifiers to job logs.

## Rollback

Disable the narrow V2 action flags for affected cohorts, then route new work to
the prior engine. Do not switch an existing quote's `engineVersion`, delete V2
records, or break already issued links. V2 public read resolution remains on so
issued documents and evidence stay accessible according to retention policy.
