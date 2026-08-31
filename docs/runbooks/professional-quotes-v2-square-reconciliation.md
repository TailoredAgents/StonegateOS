# Professional Quotes V2 Square deposit reconciliation

Owner: Finance Operations with Engineering on-call  
Applies to: Square-hosted Quote V2 deposit checkout  
Last reviewed: 2026-08-30

## Source of truth

The browser return is never payment proof. A deposit is complete only after a
verified Square webhook or an authenticated provider retrieval matches the
stored payment attempt, Square order/payment IDs, exact USD amount, merchant
location, response, quote version, and purpose. The CRM owns proposal
itemization; Square Checkout collects one exact deposit amount with tipping and
coupons disabled.

Never paste access tokens, customer capability URLs, provider payloads, or buyer
PII into tickets. Work from quote/version/response/payment-attempt/payment/
appointment IDs and correlation IDs.

## Before enabling a cohort

- Configure a matching Square application, access token, merchant location,
  environment, and verified webhook signature key.
- Confirm the hosted payment-link request uses an idempotency key, exact USD
  amount, opaque return state, prefilled buyer data where allowed, and no
  tipping/coupon behavior.
- Prove success, decline, timeout, abandoned checkout, duplicate webhook,
  provider retrieval, late capture, rebook, and refund-review cases in the
  selected Square environment.
- Verify the deposit and booking feature flags can be disabled independently.
- Confirm Finance and Sales queues have owners for late capture and refund work.

## Normal reconciliation

1. Load the accepted response and confirm its version, configuration hash,
   accepted total/range, and deposit cents.
2. Load the one active deposit payment attempt for that response. Confirm its
   expected cents/currency and stored Square link/order references.
3. Retrieve the Square order/payment using server credentials or process the
   signature-verified webhook. Confirm amount, USD currency, location, status,
   order/payment linkage, and capture time.
4. Upsert the provider event and ledger idempotently. Duplicate webhooks must
   return the existing result and must not allocate a second deposit.
5. If the hold is still active and the slot remains valid, consume it and create
   the one appointment bound to the response/version. Send one combined
   accepted-and-booked confirmation.
6. If scheduling mode is staff follow-up, record the deposit and create the
   scheduling task without creating an appointment.

## State procedures

### Checkout abandoned or expired without capture

- Leave the response `Accepted · Deposit due`.
- Expire/release the slot hold; do not decline or undo acceptance.
- Mark the attempt expired/canceled only after provider retrieval confirms no
  capture.
- Let the customer select a new slot and create one replacement active attempt.

### Browser returns before the webhook

- Display a pending-verification state and poll the tokenless return-status
  endpoint with backoff.
- Do not book, show paid, or send success based on query parameters.
- Reconcile from the webhook/provider record; if provider service is unavailable,
  retain pending state and surface a retryable support path.

### Decline

- Store the safe provider status/error code on the attempt without card data.
- Keep acceptance intact and release any expired hold.
- Allow a replacement checkout using a new idempotency key; never reuse a
  provider payment ID.

### Provider timeout or indeterminate result

- Mark `reconciliation_required`, not failed or paid.
- Retrieve by stored order/payment/idempotency references before retrying.
- Do not create another attempt while the original could still capture.
- Escalate when provider retrieval remains indeterminate beyond the support SLA.

### Duplicate webhook

- Verify the provider-event uniqueness receipt returns the original processing
  result.
- Confirm there is one completed deposit allocation, one consumed hold, one
  appointment, and one combined notification.
- A duplicate record is a zero-tolerance incident even if the amount is correct.

### Payment captures after the hold expires or the slot conflicts

- Preserve the completed deposit; do not create a conflicting appointment.
- Show `Deposit received—scheduling confirmation needed`.
- Create one urgent staff rebook/refund task and contact the customer with an
  explicit choice permitted by policy.
- Link any new appointment to the same accepted response and configuration.

### Amount, currency, location, or identity mismatch

- Do not allocate the payment or create an appointment.
- Disable deposits/booking for the affected cohort and raise
  `quote_v2_total_mismatch`.
- Preserve the provider event and ledger attempt, then investigate request
  construction, merchant configuration, and webhook routing.
- Finance decides refund/exception treatment; engineering never edits proposal
  or response evidence to make the values match.

### Refund review

- Retrieve and verify the original completed Square payment.
- Require the normal refund permission/confirmation and a documented reason.
- Create the provider refund idempotently and store it in the payment ledger.
- A refund does not delete or rewrite the acceptance response. Update the staff
  task and customer communication with the verified refund state.

## Closeout evidence

An incident or daily reconciliation is complete only when:

- Square and CRM agree on payment/order IDs, exact cents, USD currency, location,
  capture/refund status, and timestamps.
- The payment is allocated once to the accepted response and exact version.
- The hold is active/consumed/released consistently with the one appointment.
- Customer messaging occurred exactly once for the final state.
- Operational counts for value mismatch, duplicate deposit/booking, expired
  active holds, and reconciliation-required attempts return to zero or have a
  named, time-bound exception owner.
