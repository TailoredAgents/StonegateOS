# Environment Catalog (Curated)

Single source of truth for all env vars:
- `StonegateOS/.env.example`

This doc highlights the **high-impact** env vars and which runtime they affect.

---

## Service: Site (`apps/site`)

Required for normal operation:
- `NEXT_PUBLIC_SITE_URL` (canonical + metadata)
- `NEXT_PUBLIC_API_BASE_URL` (browser calls to API)
- `API_BASE_URL` (server actions calling API)
- `ADMIN_API_KEY` (Team Console server actions → API)

Public branding (build-time, keeps marketing pages cacheable):
- `NEXT_PUBLIC_COMPANY_NAME`
- `NEXT_PUBLIC_COMPANY_PHONE_E164`, `NEXT_PUBLIC_COMPANY_PHONE_DISPLAY`
- `NEXT_PUBLIC_COMPANY_EMAIL`
- `NEXT_PUBLIC_COMPANY_LOGO_PATH`
- `NEXT_PUBLIC_COMPANY_SERVICE_AREA`
- `NEXT_PUBLIC_COMPANY_HOURS_SUMMARY`
- `NEXT_PUBLIC_COMPANY_HQ_CITY`, `NEXT_PUBLIC_COMPANY_HQ_STATE`, `NEXT_PUBLIC_COMPANY_HQ_COUNTRY`
- `NEXT_PUBLIC_GOOGLE_BUSINESS_PROFILE_URL`
- `NEXT_PUBLIC_FACEBOOK_PAGE_URL`, `NEXT_PUBLIC_INSTAGRAM_URL`

Ad tracking:
- `NEXT_PUBLIC_GOOGLE_ADS_TAG_ID`
- `NEXT_PUBLIC_GOOGLE_ADS_LEAD_SEND_TO`, `NEXT_PUBLIC_GOOGLE_ADS_CONTACT_SEND_TO`
- `NEXT_PUBLIC_META_PIXEL_ID`
- `NEXT_PUBLIC_GA4_ID`

Public chat/agent endpoints (if enabled):
- `OPENAI_API_KEY`, `OPENAI_MODEL`

---

## Service: API (`apps/api`)

Always required:
- `DATABASE_URL`
- `ADMIN_API_KEY`
- `API_BASE_URL` (public base URL for links and callbacks; must be correct in production)

Cross-origin:
- `CORS_ALLOW_ORIGINS` (typically includes the site origin)

Quote/booking behavior:
- `INSTANT_QUOTE_DISCOUNT` (percent, e.g. `0.15`)
- `INSTANT_QUOTE_DISCOUNT_JUNK_AMOUNT` (fixed dollars)
- `INSTANT_QUOTE_DISCOUNT_DEMO_AMOUNT` (fixed dollars)
- `APPOINTMENT_CAPACITY` (1 = no double-booking; 2 = two trailers; etc.)

Providers:
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Meta: `FB_*`, `META_*`
- Google Ads: `GOOGLE_ADS_*`
- Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_WEBHOOK_URL`
- OpenAI: `OPENAI_API_KEY` (+ optional model overrides)

---

## Service: Outbox Worker (root script)

Entrypoint:
- `StonegateOS/scripts/outbox-worker.ts`

Important:
- Worker must have DB + provider credentials, because it sends messages and runs sync jobs.

Worker tuning:
- `OUTBOX_BATCH_SIZE`
- `OUTBOX_POLL_INTERVAL_MS`
- `SEO_AUTOPUBLISH_INTERVAL_MS`, `SEO_AUTOPUBLISH_DISABLED`
- `GOOGLE_ADS_SYNC_INTERVAL_MS`, `GOOGLE_ADS_SYNC_DISABLED`

Sales automation toggles:
- `SALES_ESCALATION_CALL_ENABLED` (`0` disables)
- `SALES_AUTO_FIRST_TOUCH_SMS_ENABLED` (`0` disables)

---

## Service: Discord agent worker (“Jarvis”)

Entrypoint:
- `StonegateOS/scripts/discord-agent-bot.ts`

Required:
- `DISCORD_BOT_TOKEN`
- `DISCORD_AGENT_SITE_URL`
- `AGENT_BOT_SHARED_SECRET`

High-impact UX controls:
- `DISCORD_COMMAND_PREFIX`
- `DISCORD_REQUIRE_MENTION`
- `DISCORD_WAKE_WORDS`
- `DISCORD_RESPOND_ALL`
- `DISCORD_DM_ONLY`
- `DISCORD_CONTEXT_MESSAGE_LIMIT`

Scheduled reports/monitoring (optional):
- `DISCORD_REPORTS_ENABLED`, `DISCORD_DAILY_REPORT_AT`, `DISCORD_REPORT_TIMEZONE`
- `DISCORD_MONITOR_ENABLED`, `DISCORD_MONITOR_CHECK_MS`

