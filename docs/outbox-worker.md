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

Pick one of these lightweight strategies so the worker runs beside the API.

### PM2 (recommended)

```bash
pm2 start pnpm --name stonegate-outbox --interpreter pnpm -- \
  outbox:worker

# Optional: poll every 5 seconds
pm2 start pnpm --name stonegate-outbox --interpreter pnpm -- \
  env OUTBOX_POLL_INTERVAL_MS=5000 pnpm outbox:worker

pm2 save
```

### Systemd (Linux)

1. Create `/etc/systemd/system/myst-outbox.service`:

   ```ini
   [Unit]
Description=StonegateOS Outbox Worker
   After=network.target

   [Service]
   WorkingDirectory=/opt/mystos
   Environment=NODE_ENV=production
   Environment=OUTBOX_POLL_INTERVAL_MS=5000
ExecStart=/usr/bin/pnpm outbox:worker
   Restart=always
User=stonegate

   [Install]
   WantedBy=multi-user.target
   ```

2. Reload and start:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now myst-outbox
   ```

### Task Scheduler (Windows)

Create a basic task that runs `pnpm outbox:worker` at startup and repeats every minute. Alternatively, set `OUTBOX_POLL_INTERVAL_MS` and let the process poll inside a hidden PowerShell window.

## Monitoring

- Worker logs are emitted to stdout. Capture them via PM2 log files, systemd `journalctl`, or redirect to a log aggregator.
- Metrics to watch:
  - `outbox_events` rows without `processed_at`
  - Worker batch summary (`processed`, `skipped`, `errors`)
- If you notice rows piling up, check that the worker is running and that external services (Twilio, SMTP, OpenAI) are reachable.

## Manual Dispatch

Need to drain the queue on demand? Use the admin endpoint (requires `ADMIN_API_KEY`):

```bash
curl -X POST http://localhost:3001/api/admin/outbox/dispatch \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ADMIN_API_KEY" \
  -d '{"limit": 10}'
```

The response includes how many events were processed, skipped, or errored, and marks each row with `processed_at`.

