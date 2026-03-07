# Diagrams (Mermaid)

These diagrams are intended for quick “system shape” comprehension.

## Component map (production)

```mermaid
flowchart LR
  User[Customer / Partner / Staff] -->|HTTPS| Site[Site service (apps/site)]
  Site -->|HTTPS| Api[API service (apps/api)]
  Api --> DB[(Postgres)]
  Worker[Outbox Worker] --> Api
  Worker --> DB
  Discord[Discord Agent Worker] --> Api

  Twilio[Twilio] -->|webhooks| Api
  Meta[Meta/Facebook] -->|webhooks| Api
  SMTP[SMTP Provider] <-->|send| Worker
  GoogleAds[Google Ads API] <-->|sync| Worker
  GoogleCal[Google Calendar] <-->|sync| Api
```

## Public `/book` quote → book sequence

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer Browser
  participant S as Site (apps/site)
  participant A as API (apps/api)
  participant DB as Postgres
  participant W as Outbox Worker
  participant T as Twilio

  C->>S: GET /book
  S-->>C: HTML + LeadForm
  C->>A: POST /api/junk-quote (types, size, zip, photos...)
  A->>DB: upsert contact/property/lead + instant_quote
  A->>DB: insert outbox_events (lead.alert, followup.schedule, ...)
  A-->>C: quote range (low/high + discount)
  C->>A: POST /api/junk-quote/availability (instantQuoteId + address)
  A->>DB: check appointments + holds + capacity
  A-->>C: slot list
  C->>A: POST /api/junk-quote/hold (slot)
  A->>DB: insert appointment_holds
  A-->>C: holdId
  C->>A: POST /api/junk-quote/book (instantQuoteId + holdId + address)
  A->>DB: create appointment + link to lead/property
  A->>DB: enqueue outbox_events (confirmations/alerts)
  A-->>C: booking confirmation payload
  W->>DB: poll outbox_events
  W->>T: send SMS (if configured)
```

## Inbound SMS → inbox → automation

```mermaid
sequenceDiagram
  autonumber
  participant Tw as Twilio
  participant A as API
  participant DB as Postgres
  participant W as Outbox Worker

  Tw->>A: POST /api/webhooks/twilio/sms
  A->>DB: upsert thread + insert conversation_message (inbound)
  A->>DB: insert outbox_events type=message.received
  A-->>Tw: 200 OK (empty TwiML)
  W->>DB: poll outbox_events
  W->>DB: load context (contact/lead/thread/policy)
  W->>DB: possibly insert draft/outbound message + outbox message.send
```

## Partner booking (portal)

```mermaid
sequenceDiagram
  autonumber
  participant P as Partner Browser
  participant S as Site (partners UI)
  participant A as API (portal routes)
  participant DB as Postgres
  participant W as Outbox Worker

  P->>S: GET /partners/login
  S-->>P: login UI
  P->>A: token exchange / session
  A->>DB: create partner_session
  P->>A: POST /api/portal/bookings
  A->>DB: create appointment + partner_booking
  A->>DB: queue outbox notifications
  W->>DB: process outbox events
```

