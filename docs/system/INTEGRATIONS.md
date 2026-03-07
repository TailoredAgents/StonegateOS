# Integrations Runbook (Curated)

This doc summarizes what StonegateOS integrates with and where to configure it.
For detailed setup steps that already exist, also see:
- Render: `StonegateOS/DEPLOY-ON-RENDER.md`
- Meta setup: `StonegateOS/docs/meta-facebook-setup.md`
- Marketing/Google Ads: `StonegateOS/docs/marketing.md`
- Website analytics: `StonegateOS/docs/web-analytics.md`

Source env reference:
- `StonegateOS/.env.example`

---

## Twilio (SMS + calls)

### Inbound SMS
- Configure Twilio Messaging webhook to:
  - `POST /api/webhooks/twilio/sms`
- Handler: `StonegateOS/apps/api/app/api/webhooks/twilio/sms/route.ts`
- Notes:
  - Inbound messages are normalized into `conversation_threads` + `conversation_messages`.
  - Media is supported via MMS (Twilio will fetch media URLs; app may proxy images).

### Inbound calls
Current code supports:
- Logging missed calls:
  - `POST /api/webhooks/twilio/voice`
  - `POST /api/webhooks/twilio/call-status?mode=inbound&leg=inbound` (depending on Twilio config)
- Outbound call connect flows:
  - `GET/POST /api/webhooks/twilio/connect`
  - `GET/POST /api/webhooks/twilio/escalate`

Call blocking:
- Requires Twilio “A call comes in” to be routed to a TwiML gate that can `<Reject/>`.
- Current inbound voice handlers are primarily for logging/status, not call screening.

Env vars (API/worker):
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`

---

## SMTP email

Used for:
- outbound email messages (outbox-driven)
- partner portal notifications (if enabled)

Env vars:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

---

## Meta (Facebook/Messenger/Lead Ads)

Webhook handler:
- `POST /api/webhooks/facebook`
- `StonegateOS/apps/api/app/api/webhooks/facebook/route.ts`

Env vars:
- `FB_VERIFY_TOKEN`, `FB_APP_SECRET`
- `FB_LEADGEN_ACCESS_TOKEN`, `FB_LEAD_FORM_IDS`
- `FB_MESSENGER_ACCESS_TOKEN` / page tokens
- Optional conversions dataset: `META_DATASET_ID`, `META_CONVERSIONS_TOKEN`

---

## Google Ads (reporting + analyst)

Data sync is outbox-driven:
- Queued by worker scheduler: `StonegateOS/apps/api/src/lib/google-ads-scheduler.ts`
- Processed by outbox: `google.ads_insights.sync`

Analyst pipeline:
- Queued by scheduler: `StonegateOS/apps/api/src/lib/google-ads-analyst-scheduler.ts`
- Processed by outbox: `google.ads_analyst.run`

Env vars:
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_CUSTOMER_ID` (+ optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`)
- `GOOGLE_ADS_API_VERSION`

---

## Google Calendar

API routes:
- Status: `/api/calendar/status`
- Webhook: `/api/calendar/webhook`

Env vars:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_WEBHOOK_URL`

---

## OpenAI (AI drafting, scoring, transcription)

Used by:
- public chat (site)
- inbox draft/suggest + sales autopilot (api + worker)
- call transcription/scoring (worker)
- Discord agent (worker)

Env vars:
- `OPENAI_API_KEY`
- Models: `OPENAI_MODEL`, `OPENAI_INBOX_SUGGEST_MODEL`, `OPENAI_TEAM_MODEL`
- Tuning: `OPENAI_TEAM_REASONING_EFFORT`

---

## Discord agent (“Jarvis”)

Worker entrypoint:
- `StonegateOS/scripts/discord-agent-bot.ts`

Env vars:
- `DISCORD_BOT_TOKEN`
- `DISCORD_AGENT_SITE_URL`
- `AGENT_BOT_SHARED_SECRET`
- Optional allowlists and UX controls: see `StonegateOS/.env.example` (DISCORD_* settings)

---

## Render (deployment)

Blueprint + services:
- `StonegateOS/render.yaml`
- `StonegateOS/DEPLOY-ON-RENDER.md`

The blueprint provisions:
- site, api, outbox worker, discord agent worker, postgres

