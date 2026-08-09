# Deterministic Google Calendar fake

This loopback-only service implements the Google Calendar calls used by the CRM:
OAuth token refresh, event create/list/get/update/delete, and event watch registration.
It is for local and CI E2E/audit runs only.

Provider endpoints:

- `POST /token`
- `POST|GET /calendar/v3/calendars/:calendarId/events`
- `GET|PATCH|PUT|DELETE /calendar/v3/calendars/:calendarId/events/:eventId`
- `POST /calendar/v3/calendars/:calendarId/events/watch`

Control endpoints:

- `GET /healthz`
- `POST /__control/reset`
- `GET /__control/requests`
- `PUT /__control/scenario`

Set a scenario with JSON such as:

```json
{
  "operation": "create",
  "scenario": "rate_limited",
  "repeat": 1
}
```

Operations are `token`, `create`, `list`, `get`, `update`, `delete`, and `watch`.
Scenarios are `success`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `provider_error`, `malformed_json`, `empty_success`, and `timeout`.
`provider_error` accepts an optional 5xx `status`. A finite `repeat` produces
one-shot or bounded failures and then automatically returns to success.

Evidence is capped at 100 requests and contains metadata only. The fake never
retains or emits authorization values, OAuth credentials, request bodies, event
descriptions, attendees, customer addresses, calendar IDs, event IDs, or query
values. Reset clears scenarios, evidence, and deterministic event state.
