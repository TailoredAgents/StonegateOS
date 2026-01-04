# Meta (Facebook) CRM Integration Setup

This repo already supports:
- Facebook Lead Ads (Instant Forms) ingestion into CRM leads
- Facebook Messenger inbound messages into the inbox
- Facebook Messenger outbound replies from the CRM (Send API)
- Meta Ads Insights sync into `meta_ads_insights_daily` (for spend/clicks/impressions dashboards, plus cost-per-lead/appointment)

## Endpoints

- Webhook callback URL (Meta App → Webhooks): `https://<API_BASE_URL>/api/webhooks/facebook`
- Admin enqueue Ads Insights sync: `POST https://<API_BASE_URL>/api/admin/meta/ads/sync`
- Admin Ads summary (campaign-level by default): `GET https://<API_BASE_URL>/api/admin/meta/ads/summary?since=YYYY-MM-DD&until=YYYY-MM-DD[&level=ad]`
  - `level=campaign` (default) → aggregates by campaign
  - `level=ad` → aggregates by ad (includes `costPerLead` and `costPerConversion` where conversions = scheduled appointments)

## Required env vars (Render)

API service (`stonegate-api`):
- `FB_VERIFY_TOKEN` (your verify token string)
- `FB_APP_SECRET` (Meta App secret)
- `FB_LEADGEN_ACCESS_TOKEN` (System User token with Lead Ads + Pages permissions)
- `FB_MESSENGER_ACCESS_TOKEN` (optional; if unset we reuse `FB_LEADGEN_ACCESS_TOKEN`)
- `FB_LEAD_FORM_IDS` (optional comma-separated allowlist of form IDs)
- `FB_PAGE_ID` (optional fallback for outbound Messenger send)

Optional legacy DM webhook transport (if you already have a DM proxy service):
- `DM_WEBHOOK_URL`
- `DM_WEBHOOK_TOKEN` (optional)
- `DM_WEBHOOK_FROM` (optional)

Worker service (`stonegate-outbox-worker`) for Ads Insights sync:
- `FB_AD_ACCOUNT_ID` (ad account id, with or without `act_` prefix)
- `FB_MARKETING_ACCESS_TOKEN` (optional; if unset we reuse `FB_LEADGEN_ACCESS_TOKEN`)
- `FB_LEADGEN_ACCESS_TOKEN` (fallback token for Ads Insights if `FB_MARKETING_ACCESS_TOKEN` is unset)

Admin auth (needed for the `/api/admin/...` endpoints):
- `ADMIN_API_KEY` (send as `x-api-key` header)

## Meta App / Business Manager checklist

1. Meta App products
   - Enable: **Webhooks**, **Messenger**, **Marketing API**
2. Webhooks
   - Configure the callback URL + verify token
   - Subscribe to Page fields:
     - `leadgen` (Instant Forms)
     - `messages` (Messenger inbox)
     - Recommended for Messenger UX: `messaging_postbacks`, `messaging_referrals`
3. System User token (single-company)
   - Create a Business Manager **System User**
   - Assign the Page + Ad Account assets
   - Grant Leads Access for the Page’s forms
   - Generate an access token with required permissions (at minimum):
     - `leads_retrieval`
     - `pages_show_list`
     - `pages_manage_metadata`
     - `pages_messaging`
     - `pages_read_engagement`
     - `ads_management` (or `ads_read` if read-only)
4. Verify end-to-end
   - Use Meta “Test” tools to send a webhook event and confirm the API logs show `ok: true`
   - Submit a Lead Ad form and confirm a new lead appears in CRM

## Scheduling Ads Insights sync

The sync is processed by the outbox worker (`meta.ads_insights.sync` event).

- Manually enqueue: `POST /api/admin/meta/ads/sync` with header `x-api-key: <ADMIN_API_KEY>`
  - Body examples:
    - `{ "days": 14 }`
    - `{ "since": "2026-01-01", "until": "2026-01-31" }`
- Recommended: create a Render Cron Job that runs daily and curls that endpoint.
