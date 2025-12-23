# StonegateOS Research Notes

## Runtime and Framework Versions
- Local Node version (via `.nvmrc`): 22.20.0
- Render is pinned to Node 20 in `render.yaml`
- Next.js 15.5.5 (App Router)
- Drizzle ORM 0.44.6 / drizzle-kit 0.31.5

## Stripe Payments (Current State)
The codebase is focused on charge ingestion and reconciliation, not deposits:
- Charge backfill script: `scripts/stripe-backfill.ts`
- Admin backfill endpoint: `/api/admin/stripe/backfill`
- Charges tagged with `appointment_id` metadata can auto-attach to appointments.
- Matching logic lives in `apps/api/src/lib/stripe.ts` and `apps/api/src/lib/payment-matching.ts`.

Future exploration (not implemented): checkout links or deposits could be added later if required.

## Google Calendar Sync
Current implementation includes:
- Watch channels + incremental sync tokens
- Webhook handler at `/api/calendar/webhook`
- Sync status endpoint at `/api/calendar/status`
- State persisted in `calendar_sync_state`

Open questions (if needed later):
- Whether additional conflict resolution is required when calendar edits and internal edits collide.

## Next.js A/B Testing Strategy (Exploratory)
- Use Middleware to assign visitors deterministically (cookie-based bucketing).
- Log exposures and conversions via a server endpoint (`/api/web/ab-events`) to GA4/Meta Pixel.
- Keep SEO intact by rendering variant-aware content on the server when possible.
