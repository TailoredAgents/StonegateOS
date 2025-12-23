# SEO Agent (Autopublishing Blog) + Next Steps

This repo includes a v1 SEO agent that autopublishes blog posts and makes them indexable (routes + sitemap). This doc explains what is implemented, how to verify it is running, and what is still needed for broader SEO.

## What is implemented (v1)

### Autopublishing blog posts (2/week target)
- A background job runs inside the outbox worker (`scripts/outbox-worker.ts`) and periodically attempts to publish blog content.
- The agent is intentionally safe-by-default:
  - No automated backlink blasts.
  - No fabricated stats, awards, or partnerships.
  - No dollar amounts.
  - No service area expansion beyond Cobb/Cherokee/Fulton/Bartow.

### Storage (DB)
- Tables:
  - `blog_posts` (public posts; Markdown content + metadata)
  - `seo_agent_state` (cursor/state for topic rotation)
- Migration: `apps/api/src/db/migrations/0007_seo_blog.sql`

### Public API (read-only)
- `GET /api/public/blog` (list published posts)
- `GET /api/public/blog/:slug` (fetch a published post)

### Site pages
- `/blog` list page (server-rendered)
- `/blog/[slug]` post page (server-rendered) with `BlogPosting` JSON-LD
- Blog URLs are added to `apps/site/src/app/sitemap.ts`

### Topic rotation
- Topic list: `apps/api/src/lib/seo/topics.ts`
- Publishing logic: `apps/api/src/lib/seo/agent.ts`

### Scheduling + limits
The worker calls `maybeAutopublishBlogPost()` on an interval (default every ~6 hours), but publishing is gated:
- Max 2 posts per 7 days
- Minimum spacing of ~3 days between posts
- Uses a Postgres advisory lock to avoid double-publishing when multiple worker instances run

### Models used
- Brain model for brief/strategy: `OPENAI_MODEL` (defaults to `gpt-5-mini`)
- Voice model for final Markdown copy: `gpt-4.1-mini`

## How to verify it is running

1) Confirm tables exist (after API deploy/migrations):
- `blog_posts`
- `seo_agent_state`

2) Confirm the worker is deployed and running:
- Render worker logs for `stonegate-outbox-worker`
- Look for periodic JSON logs like:
  - `{"ok":true,"seo":{"ok":true,"skipped":false,...}}` when it publishes
  - or `skipped:true` with reasons such as `quota_met`, `too_soon`, or `openai_not_configured`

3) Confirm the public endpoints:
- `https://stonegate-api.onrender.com/api/public/blog`

4) Confirm the site renders:
- `https://stonegatejunkremoval.com/blog`

## Controls / Ops

### Disable autopublishing (optional)
- Set env var on the worker: `SEO_AUTOPUBLISH_DISABLED=1`

### Adjust the autopublish check interval (optional)
- Worker env var: `SEO_AUTOPUBLISH_INTERVAL_MS` (default ~6 hours)

### Manual run (admin-only)
There is an admin endpoint you can call (use `x-api-key: ADMIN_API_KEY`):
- `POST /api/admin/seo/run` with JSON `{ "force": true }`

## What is still needed for broader SEO

The blog agent is only one piece. Rankings typically improve through:

1) Measurement and indexing
2) Local intent coverage (service + area pages)
3) Technical SEO
4) Legit authority (citations, reviews, real mentions/links)

### Phase 1: Measurement and indexing
1) Google Search Console (GSC)
   - Add a Domain property for `stonegatejunkremoval.com`
   - Submit sitemap: `https://stonegatejunkremoval.com/sitemap.xml`
   - Confirm key pages are indexed: `/`, `/services/*`, `/areas/*`, `/blog/*`

2) Google Analytics 4 (GA4)
   - The Render env list includes `NEXT_PUBLIC_GA4_ID`, but the site currently does not inject the GA script automatically.
   - When implemented, standardize events:
     - `quote_start`
     - `quote_success`
     - `booking_success`
     - `call_click`
     - `sms_click`

### Phase 2: Local SEO foundations
- Google Business Profile: verify, keep NAP consistent, add photos and services, request reviews.
- Citations: prefer legit listings (Apple Maps, Bing Places, Yelp, Angi, Thumbtack, Nextdoor, local chambers).

### Phase 3: On-page SEO
- Expand `/services/*` pages with FAQs and schema.
- Expand `/areas/*` pages within the actual service footprint.
- Add stronger internal linking between blog posts and services.

### Phase 4: Technical SEO
- Add `LocalBusiness` JSON-LD sitewide.
- Confirm canonical tags.
- Monitor Core Web Vitals.

### Phase 5: Data-driven agent
Once Search Console has data, use it to drive topic selection and avoid thin content.
