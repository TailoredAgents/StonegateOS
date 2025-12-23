# Week 2 Summary - Quote & Schedule

## Status
Completed. This file now records what shipped and the current behavior so it does not drift.

## What shipped
1) Lead intake + estimate scheduling
- `POST /api/web/lead-intake` accepts multi-service selections, contact/property details, and scheduling preferences.
- Leads are recorded in `leads` with the full form payload.
- In-person estimate flows create an appointment and emit `estimate.requested` outbox events.

2) Quotes
- Legacy `/api/web/quote-request` is deprecated and returns HTTP 410.
- Quotes are created and sent via admin endpoints (`/api/quotes`, `/api/quotes/:id/send`).
- Customers accept/decline via `/quote/{token}` (public UI + API).

3) Chatbot
- Public chat uses `/api/chat` with OpenAI-powered responses and a booking flow.
- The chat fallback copy references trailer-volume pricing with $200 increments.

4) Notifications
- Outbox worker sends SMS/email confirmations and quote updates when Twilio/SMTP creds exist.
- If credentials are missing, the system logs structured notification payloads instead of failing.

5) Analytics
- Lead submissions emit GA4 conversions via Measurement Protocol (`apps/api/src/lib/ga.ts`).

## Notes
- Pricing is strictly based on trailer volume in $200 increments. Any previous price ranges in older docs are obsolete.
- The team UI now lives under `/team` with tabbed sections for estimates, quotes, pipeline, calendar, contacts, and payments.
