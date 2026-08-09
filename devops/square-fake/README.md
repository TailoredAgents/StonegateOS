# Deterministic Square fake

This loopback-only, nonproduction service implements every active server-side
Square HTTP read used by StonegateOS: order, payment, and refund retrieval plus
paged payment and refund listing.

Provider endpoints:

- `GET /v2/orders/:orderId`
- `GET /v2/payments/:paymentId`
- `GET /v2/refunds/:refundId`
- `GET /v2/payments`
- `GET /v2/refunds`

Control endpoints:

- `GET /healthz`
- `POST /__control/reset`
- `GET /__control/requests`
- `PUT /__control/scenario`

Operations are `retrieve_order`, `retrieve_payment`, `retrieve_refund`,
`list_payments`, and `list_refunds`. Scenarios are `success`, `unauthorized`,
`forbidden`, `not_found`, `conflict`, `unprocessable`, `rate_limited`,
`provider_error`, `malformed_json`, `empty_success`, `invalid_success`,
`no_results`, and `timeout`. A finite `repeat` enables deterministic one-shot
recovery.

Evidence is capped at 100 metadata-only records. It does not retain request or
response bodies, access tokens, URLs, provider IDs, seller location IDs, card
suffixes, receipt URLs, cursor values, or raw provider errors. Reset clears all
evidence and scenarios.
