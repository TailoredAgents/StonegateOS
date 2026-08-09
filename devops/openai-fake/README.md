# Local OpenAI fake

This service is for deterministic local and CI tests only. Docker Compose binds
it to `127.0.0.1:4011`; production code continues to default to
`https://api.openai.com/v1`.

Direct Node execution binds to `127.0.0.1` as well. Compose explicitly uses
`HOST=0.0.0.0` only inside the container, whose published host port remains
loopback-only.

Supported provider endpoints:

- `POST /v1/responses`
- `POST /v1/audio/transcriptions`

Control endpoints:

- `GET /healthz`
- `POST /__control/reset`
- `GET /__control/scenario`
- `PUT /__control/scenario`
- `GET /__control/requests`

Set a one-request failure with:

```json
{
  "endpoint": "responses",
  "scenario": "rate_limited",
  "repeat": 1
}
```

`endpoint` accepts `responses`, `transcriptions`, or `all`. Supported scenarios
are `success`, `rate_limited`, `provider_error`, `malformed_json`, `empty`,
`timeout`, and `custom`. Use `"repeat": "persistent"` when a scenario should
remain active until reset. A custom scenario also accepts `status` and
`responseBody`.

The fake never persists request bodies, prompts, audio, or authorization values.
It retains at most 100 metadata records containing the endpoint, timestamp,
content type, body size, authorization scheme, model, schema name, input count,
and modality labels. Its console output is limited to request ID, endpoint, body
size, and scenario.
