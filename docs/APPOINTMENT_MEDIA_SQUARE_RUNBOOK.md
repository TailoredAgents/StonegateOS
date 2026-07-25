# Appointment Photos and Square Tap to Pay Runbook

This is the deployment, pilot, rollback, and acceptance runbook for quoted-work
photos and in-person payments. Treat photos and payments as two separate
releases. Do not enable Square until the photo release is stable.

## Non-negotiable safety rules

- Keep the R2 bucket private. Do not enable `r2.dev` or a public custom domain.
- Keep all provider credentials on the API and worker. Never add them to
  `NEXT_PUBLIC_*` variables or the site service.
- Apply database migrations forward only. Rollback means disabling new writes,
  not reversing media migration `0058_appointment_media.sql` or payment
  migration `0059_square_payments.sql`.
- Set `DB_MIGRATION_TARGET` explicitly before every API deploy. Render fails the
  pre-deploy step when it is missing or unknown; there is no implicit `latest`
  fallback.
- Deploy the API and migration before the site for every contract change.
- A Square callback is provisional. Only provider retrieval or reconciliation
  can mark a payment verified.
- Turning off `SQUARE_POS_ENABLED` stops new payment launches. Keep the callback,
  webhook, and reconciliation worker online until every pending attempt settles.
- Job completion and payment remain separate. Never use payment success to
  complete a job.

### Remote media import boundary

Twilio and Facebook imports accept only HTTPS URLs on provider-owned domains,
and the API reapplies that allowlist plus public-IP checks after every redirect.
Downloads have a 20-second deadline and a streaming 10 MB ceiling.

Instant-quote and legacy migration URLs intentionally retain support for
arbitrary public HTTPS hosts so recoverable historical media is not discarded.
Those hosts are resolved and rejected if any answer is private, loopback,
link-local, or reserved. The importer pins the selected public address to the
download connection, and every redirect is independently allowlisted, resolved,
and pinned before it is followed. Keep `MEDIA_AUTO_IMPORT_ENABLED` off during an
unexpected import spike and review every failed/skipped migration record.

The public instant-quote upload endpoint requires an uncompressed multipart
request with a valid `Content-Length`, enforces the 10-file/10 MB-per-file
limits, admits at most two normalization requests per API instance, and has
per-client plus per-instance rate limits. Configure the production edge with
the same 101 MB request-body ceiling and a distributed rate limit; application
limits remain the final per-instance safety boundary.

Public uploads must use a Stonegate-owned, Cloudflare-proxied custom API
hostname, for example `api.stonegatejunkremoval.com`, before
`PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED` is enabled. Stonegate cannot attach its
Cloudflare WAF, body-size policy, or distributed rate limit to Render's
`stonegate-api.onrender.com` hostname. Keep the public-upload switch off while
the site still posts directly to that Render hostname. Change
`NEXT_PUBLIC_API_BASE_URL` only as an intentional DNS/proxy rollout after the
custom API hostname, TLS, CORS, health check, 101 MB ceiling, and distributed
rate limit have all been verified.

[Cloudflare Free and Pro zones currently cap uploads at 100 MB](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/),
which is below this endpoint's 101 MiB multipart ceiling and below the
worst-case ten-file batch plus multipart overhead. A WAF rule cannot raise that
plan limit. Keep public quote uploads disabled unless the zone has a verified
200 MB-or-higher Cloudflare upload limit, or replace this multipart flow with
per-file presigned/direct uploads in a follow-up release. Staff appointment
uploads use presigned R2 URLs and do not depend on this public-edge limit.

## Release owners and prerequisites

Assign one person to each role before starting:

| Role            | Responsibility                                             |
| --------------- | ---------------------------------------------------------- |
| Release lead    | Controls flags, deploy order, and rollback decisions       |
| Media verifier  | Reviews dry-run/backfill reports and R2 object checks      |
| Square verifier | Controls the Square dashboard and live charge/refund tests |
| Device testers  | One supported iPhone and one supported Android phone       |

Before deployment:

- Take a current PostgreSQL backup and record its timestamp.
- Record the last known-good API, site, and worker Render deploy IDs.
- Run `pnpm db:migrate:targets:validate` on the exact release artifact.
  Release A carries `0059_square_payments` only as inert preflight SQL so its
  deployed shell can inspect the next migration before Release B. Its runtime,
  API schema, worker, and UI remain media-only, and its Render pre-deploy
  allowlist can apply only `0058_appointment_media`. On both artifacts, the
  media target must exclude exactly `0059` and the payment target must be the
  journal head. Release B applies `0059` and adds the payment runtime.
- Confirm the API, site, and worker run Node 20.
- Confirm the production site and API HTTPS origins.
- Confirm the Square account has one Stonegate seller location for this flow.
- Confirm each pilot employee has individual Square team access. Do not use a
  shared Square login.
- Install the current Square Point of Sale app on both pilot phones and enable
  Tap to Pay for the selected location.

## 1. Provision the private R2 bucket

Create a dedicated production bucket, for example
`stonegate-appointment-media`. Cloudflare's S3-compatible endpoint is:

```text
https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Use region `auto`. Create an R2 S3 access key limited to this bucket with object
read/write access. StonegateOS stores only object keys and metadata in
PostgreSQL; browser reads and writes use short-lived presigned URLs.

Keep all public-access controls off. Cloudflare documents private buckets,
S3-compatible access, browser CORS, and lifecycle rules here:

- [R2 S3-compatible API](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [R2 object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

### Production CORS

Add the exact production site origin and any intentionally used staging origin.
Do not use `*` for production.

```json
[
  {
    "AllowedOrigins": ["https://<PRODUCTION_SITE_HOST>", "https://<STAGING_SITE_HOST>"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["content-type", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["etag", "x-amz-checksum-sha256"],
    "MaxAgeSeconds": 3600
  }
]
```

Remove the staging origin after the pilot if it is no longer needed. Verify CORS
from an actual browser; a successful server-side S3 request does not prove that
a presigned browser upload will work.

### Lifecycle policy

The worker is the source of truth for the 24-hour staging expiry and 30-day
soft-delete recovery window. As a storage-level safety net, an R2 lifecycle rule
may delete only the `staging/` prefix after two days. Do not add an expiry rule
for `appointments/` or `contacts/`; those contain durable appointment media.

The application cleanup runs from the worker at
`APPOINTMENT_MEDIA_CLEANUP_INTERVAL_MS` and can also be invoked manually with:

```bash
pnpm appointment-media:cleanup
```

### R2 environment values

Set these on both `stonegate-api` and `stonegate-outbox-worker`:

```dotenv
MEDIA_OBJECT_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
MEDIA_OBJECT_REGION=auto
MEDIA_OBJECT_BUCKET=stonegate-appointment-media
MEDIA_OBJECT_ACCESS_KEY_ID=<R2_S3_ACCESS_KEY>
MEDIA_OBJECT_SECRET_ACCESS_KEY=<R2_S3_SECRET>
MEDIA_OBJECT_FORCE_PATH_STYLE=1
MEDIA_OBJECT_AUTO_CREATE_BUCKET=0
APPOINTMENT_MEDIA_CLEANUP_INTERVAL_MS=3600000
```

`MEDIA_OBJECT_AUTO_CREATE_BUCKET` must remain `0` in production. The site service
does not receive R2 credentials.

## 2. LocalStack and E2E

The local E2E environment uses the existing LocalStack S3 service:

```dotenv
MEDIA_OBJECT_ENDPOINT=http://localhost:4566
MEDIA_OBJECT_REGION=us-east-1
MEDIA_OBJECT_BUCKET=stonegate-appointment-media-e2e
MEDIA_OBJECT_ACCESS_KEY_ID=test
MEDIA_OBJECT_SECRET_ACCESS_KEY=test
MEDIA_OBJECT_FORCE_PATH_STYLE=1
MEDIA_OBJECT_AUTO_CREATE_BUCKET=1
```

`pnpm e2e:env` copies the checked-in E2E values to the local app env files.
`MEDIA_OBJECT_AUTO_CREATE_BUCKET=1` lets the first media request create the
LocalStack bucket. The E2E environment intentionally sets
`SQUARE_POS_ENABLED=0`; automated tests must never launch or call a live payment
provider.

`pnpm e2e:env` overwrites `.env`, `apps/api/.env.local`, and
`apps/site/.env.local`. Run it only in clean CI or after backing up those local
files, and restore the original files before using any non-E2E database or
provider configuration.

## 3. Provision Square

StonegateOS uses one fixed production Square seller and location. It does not
use OAuth or multi-merchant routing.

1. Create or select the production Square application.
2. Record its production application ID, access token, and the exact Stonegate
   location ID.
3. Confirm the access token can retrieve Orders, Payments, and Refunds for that
   location.
4. Configure the fixed mobile-web callback:

   ```text
   https://<PRODUCTION_SITE_HOST>/mobile/payment-return
   ```

5. Configure the Android browser fallback:

   ```text
   https://<PRODUCTION_SITE_HOST>/mobile/square-setup
   ```

6. Create a production webhook subscription at:

   ```text
   https://<PRODUCTION_API_HOST>/api/webhooks/square
   ```

7. Subscribe to:
   - `payment.created`
   - `payment.updated`
   - `refund.created`
   - `refund.updated`

8. Copy the webhook signature key from the same subscription.
9. In Square Point of Sale settings for the chosen location, enable customer
   tipping and receipt screens. Disable every automatic/default tax, fee, and
   service charge for this location before the Android pilot. The iOS handoff
   sends `clear_default_fees=true`, but Square does not expose an equivalent
   Android mobile-web parameter. StonegateOS verifies the exact provider
   amounts and refuses to mark a mismatched charge Paid, but the Square
   location must be configured correctly to prevent an Android customer from
   being charged an unwanted fee.
10. Confirm every pilot employee is signed into the correct location and can
    open Tap to Pay before enabling StonegateOS payment collection.

Square's mobile-web handoff and webhook validation requirements are documented
in:

- [Square POS API: mobile web](https://developer.squareup.com/docs/pos-api/build-mobile-web)
- [Square POS API: mobile-web technical reference](https://developer.squareup.com/docs/pos-api/web-technical-reference)
- [Square webhook signature validation](https://developer.squareup.com/docs/webhooks/step3validate)
- [Square payment retrieval](https://developer.squareup.com/docs/payments-api/retrieve-payments)

The exact `SQUARE_WEBHOOK_NOTIFICATION_URL` value must match the URL registered
in Square, including scheme, host, path, and trailing-slash behavior. Square
includes that exact URL in its webhook signature.

### Square environment values

Set these on the API:

```dotenv
SQUARE_POS_ENABLED=0
SQUARE_ENVIRONMENT=production
SQUARE_APPLICATION_ID=<PRODUCTION_APPLICATION_ID>
SQUARE_ACCESS_TOKEN=<PRODUCTION_ACCESS_TOKEN>
SQUARE_LOCATION_ID=<STONEGATE_LOCATION_ID>
SQUARE_POS_CALLBACK_URL=https://<PRODUCTION_SITE_HOST>/mobile/payment-return
SQUARE_POS_FALLBACK_URL=https://<PRODUCTION_SITE_HOST>/mobile/square-setup
SQUARE_POS_STATE_SECRET=<RANDOM_SECRET_AT_LEAST_32_BYTES>
SQUARE_WEBHOOK_SIGNATURE_KEY=<PRODUCTION_WEBHOOK_SIGNATURE_KEY>
SQUARE_WEBHOOK_NOTIFICATION_URL=https://<PRODUCTION_API_HOST>/api/webhooks/square
SQUARE_RECONCILIATION_INTERVAL_MS=120000
```

Generate the state secret with a password manager or a cryptographic generator,
for example:

```bash
openssl rand -base64 48
```

Set only `SQUARE_ENVIRONMENT`, the Square access token, location ID, and
reconciliation interval on the worker. The application ID, callback/fallback
URLs, callback state secret, webhook signature key, and exact webhook URL are
API-only. They are not browser secrets, but the worker does not need them.

Leave `SQUARE_POS_ENABLED=0` until the live pilot step. Webhooks and scheduled
reconciliation must remain configured even while initiation is disabled.

## 4. Feature switches

These switches are API-enforced and default off in production:

| Variable                             | Effect when enabled                                             | Safe rollback behavior                                     |
| ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `APPOINTMENT_MEDIA_WRITES_ENABLED`   | Allows new authenticated staff upload intents and finalization  | Turn off; existing media remains readable                  |
| `PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED` | Allows unauthenticated customer instant-quote photo uploads     | Turn off; staff media writes remain available              |
| `MEDIA_AUTO_IMPORT_ENABLED`          | Copies inbound MMS, Messenger, and instant-quote images into R2 | Turn off; already copied media remains linked              |
| `MOBILE_OFFLINE_MEDIA_ENABLED`       | Accepts upload intents from the offline mobile queue            | Turn off; queued phone blobs remain locally recoverable    |
| `SQUARE_POS_ENABLED`                 | Allows creation/launch of new Square POS attempts               | Turn off; callbacks, webhooks, and reconciliation continue |

Change one switch at a time and record the timestamp, operator, and target pilot
users in the release log.

The staff and payment switches are global. Before an owner-only or
named-employee pilot, use the Access screen to add member-level denies for
`appointment_media.capture`, `appointment_media.manage`, or `payments.collect`
to every non-pilot account. Confirm the denied controls disappear in `/mobile`,
then enable the relevant staff switch. Remove only the relevant deny as each
employee joins the pilot. Owner wildcard access remains available for the
release lead.

Member-level denies do not constrain the public quote endpoint.
`PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED` is a separate public rollout and must stay
off throughout the staff-only photo pilot. Enable it only after the proxied
custom API hostname and edge controls described above pass verification.

## 5. Deployment order

### Release A: quoted-work photos

1. Deploy the quality-gate and shared mobile appointment components.
2. Set the API Render environment value
   `DB_MIGRATION_TARGET=0058_appointment_media`. From a trusted shell using the
   production `DATABASE_URL`, verify the exact migration selection without
   changing the database:

   ```bash
   pnpm db:migrate:media:check
   ```

   The check must report target `0058_appointment_media` and must not report
   that the database is already ahead of it, has a history gap, or has a SQL
   hash mismatch.

3. Deploy the media API with all media switches off. Render runs
   `pnpm db:migrate:media`; this command applies every missing prerequisite on a
   clean database, stops exactly at `0058_appointment_media.sql`, and cannot
   apply `0059_square_payments.sql`. The runner holds a PostgreSQL advisory
   lock, rejects a database already beyond the target, and verifies the exact
   migration-history prefix before and after applying it. Any Drizzle sequence
   repair occurs under that same lock. Wait for API health, then deploy the
   matching worker artifact.
4. Verify API/worker health and confirm that the latest migration journal row
   has the `created_at` timestamp for `0058_appointment_media`.
5. Deploy the site gallery and offline shell with switches still off.
6. Apply the non-pilot media permission denies above, leave
   `PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED=0`, then enable
   `APPOINTMENT_MEDIA_WRITES_ENABLED=1` for the owner staff pilot.
7. Test one iPhone and one Android upload, read, caption, cover, remove, restore,
   and retry flow.
8. Enable `MOBILE_OFFLINE_MEDIA_ENABLED=1` for the device pilot.
9. Run the media dry run and review every skipped item before execution.
10. Execute and verify the media backfill.
11. Enable `MEDIA_AUTO_IMPORT_ENABLED=1` for a controlled inbound-message pilot.
12. Expand to all authorized staff only after the media acceptance gates pass.
13. After the Cloudflare-proxied custom API hostname, request ceiling,
    distributed rate limit, and browser CORS checks pass, enable
    `PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED=1` for a controlled customer quote test.

### Release B: payments

1. Confirm the media rollout is stable. From a Release A Render shell or
   one-off job using the production `DATABASE_URL`, run the read-only historical
   payment audit and save its JSON output:

   ```bash
   npx -y pnpm@9.15.9 -w payment-migration:audit -- --sample-limit=25
   ```

   Review every conflict, unmatched Stripe row, overpayment, and ambiguous tip
   described in `docs/PAYMENT_MIGRATION_AUDIT.md` before proceeding.

2. Still from the deployed Release A artifact, run the inert `0059` migration
   preflight:

   ```bash
   npx -y pnpm@9.15.9 -w db:migrate:payments:check
   ```

   It must report `0058_appointment_media` as the current database state and
   only `0059_square_payments` as pending. This command acquires the migration
   advisory lock and performs no migration.

3. Before any Release B API or site deploy, apply member-level
   `payments.collect` denies to every active non-owner account except the named
   pilots. Release A can store this permission string even though its payment
   runtime is absent. Fetch each member's current `permissionsDeny` array,
   merge `payments.collect`, and PATCH the complete merged array back; the
   member endpoint replaces the array, so never overwrite existing denies with
   a one-item list. Verify every non-pilot effective session lacks
   `payments.collect`. This gate covers final-total changes and manual
   cash/check recording as well as Square collection.

4. Set
   `DB_MIGRATION_TARGET=0059_square_payments`. From a trusted shell using the
   production `DATABASE_URL`, repeat the preflight if any environment value or
   artifact changed after step 2.

5. Deploy the payment API. Render runs `pnpm db:migrate:payments` to apply
   through `0059_square_payments.sql`; wait for API health.
6. From a Release B Render shell or one-off job, run and save the audit again:

   ```bash
   npx -y pnpm@9.15.9 -w payment-migration:audit -- --sample-limit=25
   ```

   Require `"phase": "post_0059"` and review the actual legacy rows,
   duplicates, unmatched rows, and every Needs Review count against the saved
   pre-migration report before enabling any payment collector.

7. Deploy the matching payment worker and site UI with
   `SQUARE_POS_ENABLED=0`.
8. Register the live callback and webhook after their endpoints are deployed.
9. Confirm an unsigned request to the production webhook is rejected with
   `401`, proving the public route is reachable without weakening signature
   validation. Do not use Square's synthetic **Send test event** as the
   end-to-end payment check: its illustrative payment/refund IDs are not
   guaranteed to be retrievable, while StonegateOS deliberately retrieves the
   authoritative provider object before processing. The first low-dollar live
   charge and refund in step 11 are the definitive signed-webhook tests. Confirm
   those deliveries return `2xx`, then redeliver the same real event from
   Square's webhook logs and confirm the provider-event row remains idempotent.
10. Reconfirm the non-pilot denies from step 3, then enable Square for the owner
    only.
11. Run a small live charge and refund on iPhone, then Android.
12. Pilot one employee on each operating system.
13. Expand to all collectors only after every live charge reconciles to the
    correct appointment and exact job balance.

Render deploys the API and site separately. The safe sequence is always:

```text
database migration -> API -> worker -> site -> flags
```

Before each release, pause Render auto-deploy for the API, site, and worker.
Prepare Release A and Release B as separate release commits/artifacts, deploy
the selected exact commit to the API first so its pre-deploy migration runs,
and wait for its health check before manually deploying the matching worker and
site commit. Resume
auto-deploy only after the release is complete and every service is on the same
compatible release. Never set `DB_MIGRATION_TARGET=latest` during Release A or
let the site start ahead of its API contract. After Release B is stable, set
`DB_MIGRATION_TARGET=latest` explicitly so future migrations are not held at
`0059`; Render still uses the same locked, exact-prefix migration runner when
advancing to the latest journal entry.

## 6. Media dry run, backfill, and verification

Run from a Render shell or a trusted machine with production `DATABASE_URL` and
the production `MEDIA_OBJECT_*` values.

Inventory-only dry run:

```bash
pnpm appointment-media:backfill:dry-run
```

This first pass reads PostgreSQL but does not fetch remote media or write R2 or
PostgreSQL. Use it to review candidate counts, unsupported legacy records, and
relationship blockers.

Required non-writing remote preflight:

```bash
pnpm appointment-media:backfill:preflight
```

The preflight fetches every candidate through the production importer's same
HTTPS, provider-host, DNS/IP, redirect, 10 MB, and 20-second timeout controls.
It then runs the same magic-byte, declared-MIME, decode, dimension,
decompression, and corruption checks entirely in memory. It does not write R2
or PostgreSQL. Because it downloads and decodes every pending source, run it
from a trusted shell with production provider credentials and allow enough time
for the full report.

Optional limited rehearsal (the limit applies independently to each source
query):

```bash
pnpm appointment-media:backfill:preflight -- --limit=25
```

Review the JSON:

- `candidates` is the expected work by source.
- `skipped` lists legacy non-images and invalid/unsupported data URLs by ID.
- `preflight.enabled` must be `true`; `checked` and `passed` record the
  non-writing validation totals.
- `preflight.failed` reports unavailable, corrupt, oversized, unsafe-dimension,
  unsupported, and rejected media by stable source ID and category.
- `retainedWithoutAppointmentLink` means the asset was safely copied but no
  appointment link was created, usually because it belongs to a contact or an
  appointment already reached its 50-image limit.
- `failed` reports relationship blockers during dry-run/preflight and any
  source item that fails during execution.

Both dry-run commands exit nonzero when blockers are present. Execute only
after the inventory and full preflight reports are approved and contain no
failures:

```bash
pnpm appointment-media:backfill
```

The backfill is idempotent through stable source keys. Run it again after
repairing failures; already imported objects are counted as
`alreadyPresent`. Preserve legacy attachment data and provider URLs throughout
the release.

Database checks:

```sql
SELECT status, count(*) FROM media_assets GROUP BY status ORDER BY status;

SELECT source, count(*) FROM media_assets
WHERE status = 'ready'
GROUP BY source
ORDER BY source;

SELECT id, source, source_key, processing_error
FROM media_assets
WHERE status IN ('failed', 'expired')
ORDER BY updated_at DESC;

SELECT count(*) AS invalid_object_keys
FROM media_assets
WHERE original_object_key LIKE 'data:%';

SELECT appointment_id, count(*) AS active_images
FROM appointment_media
WHERE deleted_at IS NULL
GROUP BY appointment_id
HAVING count(*) > 50;
```

For a sample from each source, verify all three object keys with an S3 `HEAD`
request, compare stored size/checksum metadata, and open the authorized gallery
as owner and crew.

## 7. Payment migration and reconciliation verification

After migration, inspect the owner-only queue:

```bash
curl -fsS \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "x-actor-role: owner" \
  "https://<PRODUCTION_API_HOST>/api/admin/payments/reconciliation"
```

Trigger a reconciliation sweep when needed:

```bash
curl -fsS -X POST \
  -H "content-type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "x-actor-role: owner" \
  -d '{"sweep":true}' \
  "https://<PRODUCTION_API_HOST>/api/admin/payments/reconciliation"
```

Inspect ledger state:

```sql
SELECT provider, canonical_status, count(*), sum(job_amount_cents)
FROM payments
GROUP BY provider, canonical_status
ORDER BY provider, canonical_status;

SELECT status, count(*)
FROM payment_attempts
GROUP BY status
ORDER BY status;

SELECT provider_event_id, event_type, processing_status, error
FROM payment_provider_events
WHERE processing_status IN ('failed', 'needs_review')
ORDER BY received_at DESC;

SELECT provider_payment_id, appointment_id, canonical_status
FROM payments
WHERE provider IN ('square', 'stripe')
  AND (appointment_id IS NULL OR canonical_status = 'needs_review')
ORDER BY provider, created_at DESC;
```

The reconciliation response must include unmatched historical Stripe rows as
well as Square rows. Never heuristically attach an unmatched provider payment.
Resolve it through the owner reconciliation workflow using provider IDs and,
for Square, the actual Square order.

## 8. Automated acceptance

Before each rollout expansion:

```bash
pnpm typecheck
pnpm lint:ratchet
pnpm test
pnpm build
pnpm exec playwright test tests/e2e/specs/mobile-appointment-workflow.spec.ts \
  --project=chromium-mobile
pnpm exec playwright test tests/e2e/specs/mobile-appointment-workflow.spec.ts \
  --project=webkit-mobile
```

The full E2E stack uses:

```bash
pnpm dev:e2e
pnpm test:e2e
```

The automated Square UI test mocks the handoff boundary. Square POS does not
provide a normal NFC card-payment sandbox for this handoff, so real Tap to Pay
acceptance still requires controlled live charges.

## 9. Real-device acceptance

Record device model, OS version, browser/PWA mode, Square POS version, tester,
time, appointment ID, media IDs, payment attempt ID, provider payment ID, and
result for each case.

### iPhone and Android photo matrix

Run in both installed PWA and browser mode:

- Capture with rear camera.
- Choose one and multiple images from the library.
- Upload JPEG, PNG, WebP, and supported HEIC/HEIF.
- Confirm portrait/landscape orientation is correct.
- Confirm GPS/EXIF metadata is absent from normalized stored objects.
- Try an image just below and just above 10 MB.
- Try 10 files, then 11 files in one selection.
- Verify the 50-active-image appointment limit.
- Verify corrupt data, SVG, animated GIF, and video are rejected.
- Verify cover image, caption, ordering, fullscreen view, delete, and 30-day
  restore.
- Verify crew can capture and add an initial caption but cannot later manage,
  reorder, reassign, or remove.
- Verify read-only can view but cannot upload.
- Verify a confirmed appointment with no scope requires scope in the same manual
  photo workflow.
- Verify automatic media without scope stays visible, raises `Scope needed`,
  and blocks payment/completion.

### Offline and weak-network matrix

- Open Today online, then switch to airplane mode and relaunch `/mobile`.
- Verify address, time, status, quoted scope, and display images are available.
- Capture several photos offline and verify each appears in the queue.
- Close/reopen the PWA and confirm queued blobs remain.
- Reconnect on weak LTE and confirm two-at-a-time upload with visible progress.
- Interrupt/retry repeatedly and confirm each client UUID creates one media row.
- Expire the login, reconnect, renew the session, and confirm the queue resumes.
- Verify queues and snapshots are isolated between two employee logins.
- Verify snapshot expiry after 48 hours does not discard unsynced photo blobs.
- Verify the 24-hour stale warning and storage-quota warning.
- Verify payments and cash/check recording are disabled offline.
- On iPhone, close and reopen StonegateOS to resume; do not expect closed-app
  background upload.

### Automatic attachment matrix

- Twilio MMS exact quote/appointment relationship.
- Facebook Messenger exact quote/appointment relationship.
- Instant-quote photo conversion.
- Nearest upcoming Requested/Confirmed appointment selection.
- Deterministic earliest start, creation time, and ID tie-break.
- No upcoming appointment: retain media on the contact.
- New appointment: attach unassigned images from the prior 30 days.
- Reschedule, conversion, and cancellation without silent remapping.
- Repeated provider delivery without duplicate assets.
- Cross-contact reassign attempt is rejected.

### Square matrix on each operating system

- Square app installed and missing.
- Employee signed in and signed out.
- Correct and incorrect Square location.
- Tap to Pay enabled and incompatible device.
- Customer tip and receipt flow.
- Cancel, decline, and interrupted app switch.
- No network, killed Square app, killed StonegateOS, delayed callback, delayed
  webhook, and no callback.
- Double-tap **Accept payment** and simultaneous attempts from two phones.
- One small live charge; confirm exact appointment, location, USD job amount,
  separate tip, receipt, and verified status.
- One full refund in Square; confirm the balance reopens and tip is removed.
- One controlled partial refund; confirm `Needs review`.
- Confirm payment does not complete the job.
- Confirm completing an equivalent final job total leaves commission math
  unchanged.

## 10. Acceptance gates

Do not expand the pilot until all are true:

- No new PostgreSQL media blobs or data URLs.
- No duplicate media from retries, backfills, or repeated provider events.
- Every offline photo either uploads once or remains visibly recoverable.
- Every live Square charge maps to the correct appointment and exact amount.
- Zero duplicate or silently matched pilot payments.
- A callback by itself never marks a payment paid.
- Payment and completion states remain independent.
- Tips do not reduce job balance or enter commissionable job revenue.
- Historical Stripe and legacy-completion rows display consistently.
- `Completed job revenue`, `Payments collected`, `Outstanding balance`,
  `Refunded`, and `Needs review` are not silently blended.

## 11. Monitoring

Check the owner/system health endpoint and worker logs:

```bash
curl -fsS \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://<PRODUCTION_API_HOST>/api/admin/system/health"
```

The owner health response reports `squareConfigured` and
`objectStorageConfigured` from required environment values even while their
feature switches are off. It also performs a bounded, read-only S3
`HeadBucket` request and reports `objectStorageVerification.status` as
`verified`, `failed`, or `not_configured`. Configuration presence alone does
not prove credentials or bucket access. A failed bucket check is a warning
while media features are off and becomes a blocker when staff writes, public
uploads, or automatic imports are enabled.

Alert on:

- `object_storage` media processing/import failures.
- Staging objects or rows older than 24 hours.
- Employee-reported offline queues older than 24 hours.
- Square attempts stuck in `pending_verification`.
- Unmatched Square payments.
- Failed/needs-review provider events.
- Refund and commission-review items.
- Worker cleanup or reconciliation loop failures.

Useful worker log markers include `[appointment_media]` and `[square]`.

## 12. Rollback and incident response

### Media rollback

1. Set `PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED=0`.
2. Set `MEDIA_AUTO_IMPORT_ENABLED=0`.
3. Set `MOBILE_OFFLINE_MEDIA_ENABLED=0`.
4. Set `APPOINTMENT_MEDIA_WRITES_ENABLED=0`.
5. Leave media reads, R2, legacy attachments, and cleanup available.
6. Tell employees not to discard queued photos; they remain on the originating
   phone until upload succeeds or the employee explicitly discards them.
7. Roll the site back first if the UI is broken, then the API if necessary.
8. Do not reverse the migration or delete R2 objects.

If the database is already at `0059_square_payments` and the API must be rolled
back to the Release A runtime, set `SKIP_DB_MIGRATE=1` for that rollback deploy.
Release A's strict pre-deploy target intentionally refuses a database already
beyond `0058`. Keep all payment initiation disabled and retain a compatible
Release B callback/webhook/reconciliation path until pending attempts settle.

### Square rollback

1. Set `SQUARE_POS_ENABLED=0` immediately.
2. Leave the API callback, Square webhook, access token, and worker
   reconciliation running.
3. Review all unresolved attempts and provider events before allowing another
   payment method.
4. Record cash/check only after verifying in Square that no card payment
   succeeded.
5. Roll the site back if needed, but keep compatible API endpoints live until
   pending attempts settle.

### Common incidents

| Incident                              | Immediate action                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Browser upload has a CORS error       | Disable media writes, verify exact site origin/method/headers, then retry the same client UUID       |
| R2 is unavailable                     | Disable writes/imports; keep local queues; do not discard phone blobs                                |
| Photo processing repeatedly fails     | Preserve legacy source, inspect `processing_error`, repair, rerun idempotent backfill/import         |
| Square app is missing                 | Use `/mobile/square-setup`; install POS, sign in to the fixed location, then resume the same attempt |
| Square returned but status is pending | Do not charge again; wait for webhook/reconciliation or run an owner sweep                           |
| Wrong Square location                 | Stop collection, sign into the configured location, reconcile the existing attempt before retrying   |
| Unmatched Square payment              | Leave it in owner review; match only with authoritative Square IDs and evidence                      |
| Partial refund                        | Leave final total/completion/commissions unchanged and resolve the `Needs review` item               |

After any rollback, record the flag values, affected appointment/payment IDs,
last successful operation, pending work, and criteria for re-enabling.
