# Google Ads recommendation apply safety

## What this protects

The Marketing → Google Ads recommendation workflow separates a review decision
from a live advertising change:

1. `proposed`, `approved`, and `ignored` are CRM review states.
2. Only an `approved` customer-level negative keyword may enter an apply
   operation.
3. Applying requires `marketing.apply`, an explicit confirmation, a current
   recommendation version, and a caller-generated `Idempotency-Key`.
4. The advertising-change emergency stop is enforced by the API and shown in
   the recommendation panel. If the panel cannot verify configuration or the
   safety status, apply controls fail closed.
5. A recommendation cannot be manually marked applied. Only a Google Ads
   response containing a provider resource name can produce `applied`.

## Durable operation contract

Migration `0075_google_ads_recommendation_operations` adds a guarded attempt
ledger. Each application follows:

```text
requested → dispatched → succeeded | failed | reconciliation_required
```

- `requested` proves the CRM committed the proposed provider parameters before
  crossing the external boundary.
- `dispatched` is the no-automatic-retry boundary. Google Ads does not consume
  the CRM idempotency key, so the system does not claim provider exactly-once
  behavior.
- `succeeded` requires a provider operation/resource ID.
- `failed` means Google Ads returned a response that definitively rejected the
  mutation.
- `reconciliation_required` means the request may have reached Google Ads but
  the final effect is uncertain. The CRM quarantines the item and does not send
  it again automatically.

The database permits only one `requested` or `dispatched` operation per
recommendation. Lifecycle checks require timestamps and terminal evidence to
agree with the stored state. A transition trigger requires an initial
`requested` row, exact version increments, immutable attempt identity, legal
state transitions, and immutable terminal rows. Provider request keys and
terminal audit links are unique, and terminal operations reference a real
append-only audit event. Actor IDs are immutable verified snapshots rather
than deletion-sensitive foreign keys. Every requested, dispatched, and
terminal checkpoint has verified actor, session, correlation, caller-key hash,
provider certainty, and audit evidence.

## HTTP contracts

Single review decisions require:

- `Idempotency-Key`
- `If-Match` containing the recommendation `version`
- `confirmation` matching `approve`, `ignore`, or `reset`

Bulk review decisions carry an expected version for every selected row and are
all-or-nothing under row locks.

Single and bulk apply requests require:

- `marketing.apply`
- the advertising kill switch to be off
- `Idempotency-Key`
- a current version for every recommendation
- `apply_google_ads_change` or `apply_google_ads_changes` confirmation

Bulk apply is limited to 25 items and dispatches at most three provider
requests concurrently. Each item retains its own operation and audit evidence.
A mixed provider result returns a non-success HTTP response; the item states in
the refreshed panel are the source of truth.

The terminal provider outcome commits before the HTTP replay receipt. If that
receipt write is temporarily unavailable, the API returns the truthful
terminal outcome with `x-idempotency-receipt: pending`; a later same-key call
rebuilds the receipt from the durable operation without another provider call.

## Failure rules

| Failure point                                                                                | Stored/result behavior                                  | Automatic provider retry                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Invalid input, stale version, denied permission, or emergency stop                           | No provider operation                                   | No                                                          |
| OAuth/configuration failure before operation preparation                                     | Recommendation remains approved; typed failure          | Safe caller retry with the same key while its lease permits |
| Google Ads 4xx rejection after dispatch                                                      | `failed`                                                | No                                                          |
| Transport failure, timeout, 408, 5xx, unreadable/malformed success, or missing resource name | `reconciliation_required`                               | No                                                          |
| Process resumes a durable `dispatched` operation                                             | `reconciliation_required` without another provider call | No                                                          |
| Google returns a resource but the first local finalization is uncertain                      | Resource ID retained with `reconciliation_required`     | No                                                          |

## Verification

Focused automated coverage lives in
`apps/api/src/__tests__/google-ads-recommendation-safety.test.ts`. It covers
transition planning, provider certainty, durable schema/source contracts,
permission/idempotency/version ordering, explicit confirmations, truthful bulk
failure behavior, and Site controls.

Before release, still run the migration and the route suite against disposable
PostgreSQL plus a controllable Google Ads sandbox. Runtime evidence must include
concurrent clicks, a crash at each durable checkpoint, provider 4xx/5xx,
transport timeout, malformed success, successful resource capture, emergency
stop, role denial, and idempotent replay. This document does not claim those
environment-dependent scenarios have run until their artifacts are attached.
An operator workflow for resolving quarantined reconciliation records is also
still required before the overall CRM can be certified; this slice exposes and
blocks those records but does not guess their provider outcome.
