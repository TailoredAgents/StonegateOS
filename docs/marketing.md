# Marketing (Google Ads + AI Analyst)

The Marketing section in `/team` is approve-first: it can sync data and generate recommendations, but it never auto-applies changes to Google Ads unless you explicitly approve/apply them.

Where to find it:
- `/team` -> **Marketing** -> **Google Ads** (tab id: `google-ads`)

## What it does
- **Google Ads sync**: pulls campaign/search-term/conversion data into Postgres for reporting.
- **AI Marketing Analyst**: summarizes performance and proposes actions (negatives, pause candidates, checklists).
- **Audit trail**: approvals/ignores are logged so you can review what changed and why.

## How to use (recommended workflow)
1. In `/team` -> **Marketing** -> **Google Ads**, click **Sync now**.
2. Review the 7-day summary (clicks, spend, conversions).
3. Click **Generate report**.
4. Approve/ignore recommendations you agree with (keep it manual until you're confident).
5. Apply approved negatives/changes in Google Ads, or use the in-app apply flow if enabled.

## Safe-by-default behavior
- No changes are pushed to Google Ads automatically.
- Analyst runs are manual by default; you can enable auto-run for report generation (still approve-first).

## Environment / setup (Render)
These are required for the Google Ads API integration:
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_CUSTOMER_ID` (no dashes)
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (optional MCC/manager account id; no dashes)

Notes:
- Set the same Google Ads env vars on **API** and **outbox worker**.
- The worker performs scheduled syncs (unless disabled); the UI can also trigger on-demand sync.

## Troubleshooting
- **401 / unauthorized**: wrong OAuth client, wrong refresh token scope, or the OAuth user lacks access to the Ads account.
- **CUSTOMER_NOT_FOUND**: wrong `GOOGLE_ADS_CUSTOMER_ID` or using a manager id where an account id is expected.
- **No data**: new campaigns can take time to populate; also verify spend/impressions in Google Ads UI.
