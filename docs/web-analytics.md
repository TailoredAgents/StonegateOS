# Website Analytics (First-Party)

Website Analytics is a lightweight, first-party event system for the **public site only** (including `/book`). It is designed to be low overhead and privacy-conscious (no session replay).

## What it tracks
- **Visits / page views**
- **CTA clicks** (e.g., call clicks)
- **/book funnel** (step views, submit, quote, booking attempt/success/fail)
- **Form errors** (bucketed by error key; no payload stored)
- **Core Web Vitals** (LCP/CLS sampled)

Raw events are retained for 30 days; aggregates are stored for reporting.

## Where to view it
`/team` → **Marketing** → **Website analytics**

## How quickly it updates
Events are batched and flushed periodically; the dashboard should typically update within ~1 minute.

## Environment / setup (Render)
The public site sends events to the API at:
`{NEXT_PUBLIC_API_BASE_URL}/api/public/web-events`

Required on the **site** service:
- `NEXT_PUBLIC_API_BASE_URL` (must point to the public API URL)

Also ensure API CORS allows the site origin:
- `CORS_ALLOW_ORIGINS` should include your site domain (e.g., `https://example.com`).

## Privacy notes
- ZIP is bucketed for service-area reporting and should not be stored as a raw ZIP in analytics.
- No session replay/heatmaps are enabled by this system.

