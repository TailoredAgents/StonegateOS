# Deterministic Google Ads fake

This loopback-only, nonproduction service implements every active server-side
Google Ads provider request: OAuth refresh, accessible-customer discovery,
GAQL search streaming, and customer negative-keyword mutation.

Provider endpoints:

- `POST /token`
- `GET /v25/customers:listAccessibleCustomers`
- `POST /v25/customers/:customerId/googleAds:searchStream`
- `POST /v25/customers/:customerId/customerNegativeCriteria:mutate`

Control endpoints:

- `GET /healthz`
- `POST /__control/reset`
- `GET /__control/requests`
- `PUT /__control/scenario`

Operations are `token`, `accessible_customers`, `search_stream`, and
`mutate_negative_keyword`. Scenarios are `success`, `unauthorized`, `forbidden`,
`not_found`, `conflict`, `unprocessable`, `rate_limited`, `provider_error`,
`malformed_json`, `empty_success`, `invalid_success`, `no_results`, and
`timeout`. `empty_success` is a zero-byte HTTP 200 body; `invalid_success`
returns operation-specific invalid shapes; `no_results` returns valid empty
arrays for read operations. `provider_error` accepts an optional 5xx `status`;
finite `repeat` values enable one-shot recovery.

The search fake recognizes every GAQL shape currently emitted by the CRM:
conversion actions, campaign metrics, search terms, and campaign conversions.

Evidence is capped at 100 requests and contains metadata only. It never retains
or emits OAuth/access/developer tokens, provider request or response bodies,
customer/login-customer/campaign/ad-group/account/resource IDs, GAQL query text,
negative-keyword text, budget values, or raw provider errors. Reset clears all
evidence and scenarios.
