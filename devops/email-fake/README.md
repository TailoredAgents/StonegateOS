# Deterministic email provider fake

This nonproduction service is the bounded SMTP boundary used by local and CI
E2E runs. Its SMTP listener can relay successful messages to MailHog so the
existing content assertions remain available, while its control plane retains
only privacy-safe delivery metadata.

The production inventory is centralized in `apps/api/src/lib/email-provider.ts`
through `sendEmailMessage`: durable and legacy outbox email, team and partner
magic links, partner invites and acknowledgements, contact-less booking
confirmation/reminder/cancellation, quote send/decision fallbacks, and internal
quote alerts. `notifications.ts` has no independent transport.

Relay is disabled by default. The only accepted relay targets are the exact
local MailHog service (`mailhog:1025`) or port 1025 on a loopback host, supplied
through `EMAIL_FAKE_FORWARD_SMTP_HOST` and
`EMAIL_FAKE_FORWARD_SMTP_PORT`. Other hosts and ports fail startup.

Control endpoints:

- `GET /healthz`
- `POST /__control/reset`
- `GET /__control/requests`
- `PUT /__control/scenario`

The single operation is `send_email`. Scenarios are `success`,
`temporary_rejection`, `permanent_rejection`, `partial_acceptance`,
`data_temporary_error`, `data_permanent_error`, `disconnect_after_send`,
`timeout`, and `malformed_response`. A finite `repeat` supports deterministic
one-shot recovery.

Evidence is capped at 100 metadata-only records. The fake never retains or logs
message bodies, subjects, recipients, credentials, URLs, message identifiers,
dispatch identifiers, or identifier suffixes. Reset clears requests and the
active scenario, destroys every SMTP/relay socket, and advances a generation so
late in-flight work cannot contaminate the next test.
