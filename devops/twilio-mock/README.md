# Deterministic Twilio fake

This local-only service exercises Stonegate SMS and outbound-call behavior without contacting Twilio. Its host default is `127.0.0.1`; Docker must set `HOST=0.0.0.0` only inside the container, while Compose publishes the port on host loopback only.

Never put a real Twilio account SID, token, phone number, or customer message into this service. Team E2E startup independently requires the documented sentinel credentials and loopback endpoint before any fixture seed runs.

## Provider endpoints

- `POST /2010-04-01/Accounts/:accountSid/Messages.json`
- `POST /2010-04-01/Accounts/:accountSid/Calls.json`
- `GET /2010-04-01/Accounts/:accountSid/Calls/:callSid/Recordings.json`
- `GET /2010-04-01/Accounts/:accountSid/Recordings/:recordingSid.wav|mp3`
- `DELETE /2010-04-01/Accounts/:accountSid/Recordings/:recordingSid.json`

The recording list is empty and downloads return 404 until a synthetic recording fixture is deliberately added through `POST /__control/recordings/seed`. The synthetic fixture contains no customer data. Deleting an absent fixture returns 404 so clients can prove their explicit idempotent-delete rule.

## Controls

- `GET /healthz`
- `GET /__control/state`
- `GET /__control/requests`
- `POST /__control/reset`
- `PUT /__control/scenario`
- `POST /__control/recordings/seed`

Configure a scenario with JSON such as:

```json
{ "name": "rate_limited", "repeat": 1 }
```

Supported names are `success`, `rate_limited`, `provider_error`, `invalid_request`, `malformed_json`, `empty_success`, `not_found`, `oversized_json`, `oversized_audio`, and `timeout`. `repeat` makes a failure deterministic and one-shot; `delayMs` controls when the timeout scenario destroys the socket.

Request evidence is capped at 100 entries. It records operation, timing, sizes, one-way hashes, and channel metadata. It never records authorization values, message bodies, account identifiers, provider resource identifiers, or phone suffixes, and logs contain only operation names and statuses. `/calls` retains only hashed address/account evidence. `/messages` retains up to 200 synthetic successful SMS records for E2E content assertions; reset it between tests and never use customer data.
