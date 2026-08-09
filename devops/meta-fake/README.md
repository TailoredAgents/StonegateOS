# Deterministic Meta Graph fake

This loopback-only service implements the Meta Graph operations the Stonegate
API currently uses: Messenger text, typing and media sends; page-token,
identity, lead and diagnostics lookups; Ads Insights pagination; and
Conversions API events.

It is for local E2E and CRM-audit runs only. The shared SDK rejects a loopback
Graph base in production and rejects the real Graph host in E2E/audit mode.

## Control API

- `GET /healthz`
- `GET /__control/state`
- `GET /__control/requests`
- `POST /__control/reset`
- `PUT /__control/scenario`

Scenario payloads accept `name`, optional `operation`, optional `repeat`, and
optional `delayMs`. Supported names are `success`, `oauth_denied`,
`permission_denied`, `not_found`, `conflict`, `rate_limited`,
`provider_error`, `malformed_json`, `empty_success`, `timeout`, and
`media_partial_failure`. Use `repeat: 1` for a one-shot failure followed by
automatic recovery. `media_partial_failure` also accepts `mediaFailureAt`.
Ads success responses accept `adsPages` of 1 or 2.

The fake retains at most 100 request-evidence records. Evidence contains only
operation metadata, sizes, booleans, short hashes and four-character ID
suffixes. It never retains access-token values, recipient IDs, message bodies,
media URLs, names, prompts or raw request bodies. Reset clears all evidence and
scenario state.
