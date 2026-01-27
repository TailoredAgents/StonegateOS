# Outbox Worker

StonegateOS records customer-facing follow-ups (notifications, analytics hooks, etc.) in the `outbox_events` table. A small worker drains that queue so the API stays fast and resilient. The worker also runs the SEO autopublisher on an interval.

## Environment

The worker reads the same `.env` values as the API plus a couple of optional knobs:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OUTBOX_BATCH_SIZE` | Max events to process per cycle | `10` |
| `OUTBOX_POLL_INTERVAL_MS` | Milliseconds to sleep between cycles. `0` runs once and exits. | `0` |
| `SEO_AUTOPUBLISH_INTERVAL_MS` | How often to attempt SEO autopublish checks | `21600000` (6 hours) |
| `SEO_AUTOPUBLISH_DISABLED` | Set to `1` to disable SEO autopublish | unset |

Ensure the worker can see `DATABASE_URL`, `OPENAI_API_KEY`, Twilio/SMTP credentials, and any other integrations it needs to fan out notifications or publish SEO posts.

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
- Metrics to watch:
  - `outbox_events` rows without `processed_at`
  - Worker batch summary (`processed`, `skipped`, `errors`)
- If you notice rows piling up, check that the worker is running and that external services (Twilio, SMTP, OpenAI) are reachable.

## Manual Dispatch

Need to drain the queue on demand? Use the admin endpoint (requires `ADMIN_API_KEY`):

```bash
curl -X POST http://localhost:3001/api/admin/outbox/dispatch \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{"limit": 10}'
```

The response includes how many events were processed, skipped, or errored, and marks each row with `processed_at`.

