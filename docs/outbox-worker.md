# Outbox Worker

StonegateOS records customer-facing follow-ups (notifications, analytics hooks, etc.) in the `outbox_events` table. A small worker drains that queue so the API stays fast and resilient.

In production, the worker is also responsible for scheduled “background” jobs like:

- SEO private-draft generation
- Google Ads sync + AI analyst reports
- Sales autopilot draft/send tasks
- Call transcription/analysis + coaching summaries
- Partner access-link crash recovery (quarantine before dispatch; manual reconciliation after dispatch)

## Environment

The worker reads the same `.env` values as the API plus a couple of optional knobs:

| Variable                              | Purpose                                                                        | Default              |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------------------- |
| `OUTBOX_BATCH_SIZE`                   | Max events to process per cycle                                                | `10`                 |
| `OUTBOX_POLL_INTERVAL_MS`             | Milliseconds to sleep between idle cycles (`250`–`30000`). `0` runs once.      | `0`                  |
| `OUTBOX_HEARTBEAT_INTERVAL_MS`        | Readiness heartbeat cadence (`5000`–`60000`); independent of idle log output.  | `30000`              |
| `READINESS_WORKER_MAX_AGE_MS`         | Maximum accepted heartbeat age for API readiness.                              | `90000`              |
| `SEO_AUTOPUBLISH_INTERVAL_MS`         | Compatibility name: how often to attempt SEO private-draft generation          | `21600000` (6 hours) |
| `SEO_AUTOPUBLISH_DISABLED`            | Compatibility name: set to `1` to disable SEO private-draft generation         | unset                |
| `PARTNER_INVITE_RECOVERY_INTERVAL_MS` | How often to scan for interrupted partner invite/login-link operations         | `60000`              |
| `PARTNER_INVITE_RECOVERY_BATCH_SIZE`  | Maximum interrupted access-link operations examined per scan                   | `50`                 |
| `PARTNER_INVITE_REQUESTED_STALE_MS`   | Age after which a never-dispatched request is quarantined                      | `120000`             |
| `PARTNER_INVITE_DISPATCHED_STALE_MS`  | Age after which an unfinished provider dispatch requires manual reconciliation | `600000`             |

Ensure the worker can see `DATABASE_URL`, `OPENAI_API_KEY`, Twilio/SMTP credentials, and the other integrations it needs. The worker cannot publish SEO posts; staff publication happens through the reviewed Team workflow.

## Local Usage

```bash
# Process one batch (useful during dev)
pnpm outbox:worker

# Poll every 5 seconds until interrupted
OUTBOX_POLL_INTERVAL_MS=5000 pnpm outbox:worker
```

## Production Deployment

This repo is designed to run the worker as a dedicated **Render Worker** service. The blueprint in `render.yaml` provisions `stonegate-outbox-worker` automatically.

If you are deploying elsewhere, run `pnpm outbox:worker` as a long-lived process alongside the API.

## Monitoring

- Worker logs are emitted to stdout. On Render, use the `stonegate-outbox-worker` service logs.
- Continuous workers emit compact startup, bounded heartbeat, activity, and error records. Empty polls are intentionally silent.
- Metrics to watch:
  - `outbox_events` rows without `processed_at`
  - Worker batch summary (`processed`, `skipped`, `errors`)
  - `provider_health` row `worker:outbox`; its success heartbeat advances at the configured bounded cadence
- `/api/readyz` fails closed when the configured heartbeat or dispatchable queue age is unhealthy. `/api/healthz` only proves that the API process can answer HTTP.
- If you notice rows piling up, check that the worker is running and that external services (Twilio, SMTP, OpenAI) are reachable.
- A stale partner access-link operation is never resent by the worker. `requested` operations are quarantined because no provider boundary was committed; `dispatched` operations enter the operator reconciliation queue because the provider outcome is uncertain.

## Manual Dispatch

The manual dispatch endpoint is service-only. A raw administrator key is not a
human authorization token and cannot invoke it. Use the named
`outbox-dispatcher` service principal through the deployed worker/runbook; the
response reports processed, skipped, and errored events.

## Partner access-link reconciliation

The worker never retries partner invitation or public Partner Portal login-link
providers. It makes interrupted work explicit:

- A stale `requested` operation is quarantined and its unused login token is
  invalidated because the durable provider-dispatch marker was never committed.
- A stale `dispatched` operation becomes `reconciliation_required` because an
  email or SMS provider may have accepted it before the process stopped.

Authorized operators can inspect up to 100 unresolved operations with
`GET /api/admin/partners/invite-operations`. A conclusive resolution is posted
to the same route with the operation's integer `If-Match` version, a stable
`Idempotency-Key`, every requested channel, provider evidence, a 20–1000
character reason, and the outcome-specific typed confirmation. Resolution
preserves the original provider evidence and appends an audit event; it only
releases the duplicate-send guard and never sends a message itself.
