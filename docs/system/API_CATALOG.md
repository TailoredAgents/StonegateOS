# API Catalog (Curated)

This is the human + AI-friendly guide to the most important endpoints, what they do, and what auth they expect.

For a complete inventory of routes and handler files, see:
- `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`
- `StonegateOS/docs/system/API_ROUTE_INDEX_SITE.md`

---

## Auth model (high-level)

StonegateOS uses multiple “classes” of endpoints:

1. **Public endpoints (no auth)** — for the marketing/booking funnel and public assets.
2. **Admin endpoints (API key + permissions)** — used by the Team Console and internal automation.
3. **Partner endpoints (partner sessions)** — used by the partner portal UI under `/partners`.
4. **Provider webhooks** — Twilio/Meta/Email webhooks that ingest events.

### Admin API key gate
Many admin/business endpoints enforce `ADMIN_API_KEY` via `isAdminRequest`:
- Gate helper: `StonegateOS/apps/api/app/api/web/admin.ts`

### Role + permission gate (Team Console)
Most `/api/admin/*` routes also check permissions:
- Permissions helper: `StonegateOS/apps/api/src/lib/permissions.ts`

### Partner session gate
Partner portal endpoints require a partner session:
- Partner auth helper: `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`

---

## Public booking/quote funnel APIs

### Junk removal
- `POST /api/junk-quote`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/route.ts`
  - Purpose: create/update contact + lead + instant quote and return a **price range**.

- `POST /api/junk-quote/availability`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/availability/route.ts`
  - Purpose: compute available booking slots for a given `instantQuoteId` + address.

- `POST /api/junk-quote/hold`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/hold/route.ts`
  - Purpose: place a short hold on a selected slot to reduce booking races.

- `POST /api/junk-quote/book`
  - Handler: `StonegateOS/apps/api/app/api/junk-quote/book/route.ts`
  - Purpose: create an `appointments` row (self-serve booking) and enqueue confirmations/alerts.

- `POST /api/public/junk-quote/uploads`
  - Handler: `StonegateOS/apps/api/app/api/public/junk-quote/uploads/route.ts`
  - Purpose: accept 1–4 images from the public site and return signed URLs accessible to Twilio.

### Brush clearing
- `POST /api/brush-quote`
  - Handler: `StonegateOS/apps/api/app/api/brush-quote/route.ts`
  - Purpose: create lead + instant quote range for brush.
  - Booking still uses the shared `/api/junk-quote/availability|hold|book` endpoints.

### Demolition
- `POST /api/demo-quote`
  - Handler: `StonegateOS/apps/api/app/api/demo-quote/route.ts`
  - Purpose: create lead + demo estimate range.
  - Booking still uses the shared `/api/junk-quote/availability|hold|book` endpoints.

### Public quote links
- `GET /api/public/quotes/[token]`
  - Handler: `StonegateOS/apps/api/app/api/public/quotes/[token]/route.ts`
  - Purpose: view quote details via a shareable token.

---

## Public analytics ingestion

- `POST /api/public/web-events`
  - Handler: `StonegateOS/apps/api/app/api/public/web-events/route.ts`
  - Purpose: first-party web analytics events (used for `/book*` funnel dashboards).
  - Writes: `web_events`, `web_event_counts_daily`, `web_vitals` (prunes raw after 30 days).

---

## Webhooks (provider ingress)

### Twilio
Directory: `StonegateOS/apps/api/app/api/webhooks/twilio`
- SMS webhook: `POST /api/webhooks/twilio/sms`
- Voice “missed call” logger: `POST /api/webhooks/twilio/voice`
- Call status callback: `POST /api/webhooks/twilio/call-status`
- Outbound call connect TwiML: `GET/POST /api/webhooks/twilio/connect`
- Sales escalation TwiML: `GET/POST /api/webhooks/twilio/escalate`

Important:
- Inbound call *blocking/screening* requires Twilio to route “A call comes in” to a TwiML endpoint that can `<Reject/>`.
  The current inbound voice endpoints are primarily for **logging/status**.

### Meta (Facebook)
- `POST /api/webhooks/facebook`
  - Handler: `StonegateOS/apps/api/app/api/webhooks/facebook/route.ts`
  - Purpose: lead ads + Messenger message ingest.

### Email / DM
- `POST /api/webhooks/email`
- `POST /api/webhooks/dm`

---

## Admin APIs used by Team Console

Admin endpoints live under:
- `StonegateOS/apps/api/app/api/admin`

They cover:
- Contacts, properties, pipeline, tasks/reminders
- Inbox threads/messages, uploads, exports
- Calls/coaching, booking assistant, calendar feeds
- Expenses + receipts
- Policy + automation settings
- Partners: users, rates, bookings
- Marketing: Google Ads sync + analyst reports + recommendations, Meta insights sync

See the complete inventory:
- `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`

