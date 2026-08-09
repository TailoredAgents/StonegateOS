# SEO Agent Editorial Workflow + Next Steps

The SEO agent generates private blog drafts. A verified team member must inspect a draft, submit it for review, and explicitly publish it before public routes or the sitemap can expose it.

## What is implemented (v1)

### Private draft generation (2/week target)
- A background job runs inside the outbox worker (`scripts/outbox-worker.ts`) and periodically attempts to generate a private draft.
- Generation never sets `published_at`; only the separate, authenticated Review → Published transition can do that.
- The agent is intentionally safe-by-default:
  - No automated backlink blasts.
  - No fabricated stats, awards, or partnerships.
  - No dollar amounts.
  - No claims outside your configured service area (keep location language aligned with your real coverage).

### Storage (DB)
- Tables:
  - `blog_posts` (public posts; Markdown content + metadata)
  - `seo_agent_state` (cursor/state for topic rotation)
- Base migration: `apps/api/src/db/migrations/0007_seo_blog.sql`
- Editorial safety migration: `apps/api/src/db/migrations/0074_seo_editorial_workflow.sql`

### Public API (read-only)
- `GET /api/public/blog` (list published posts)
- `GET /api/public/blog/:slug` (fetch a published post)

### Site pages
- `/blog` list page (server-rendered)
- `/blog/[slug]` post page (server-rendered) with `BlogPosting` JSON-LD
- Blog URLs are added to `apps/site/src/app/sitemap.ts`

### Topic rotation
- Topic list: `apps/api/src/lib/seo/topics.ts`
- Draft-generation logic: `apps/api/src/lib/seo/agent.ts`

### Scheduling + limits
The worker calls `maybeGenerateSeoDraft()` on an interval (default every ~6 hours). Generation is gated to two drafts per seven days with roughly three days between scheduled drafts. A Postgres advisory lock prevents concurrent generation. Public publishing separately enforces at most two posts per seven days and at least three days between posts.

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
  - `{"ok":true,"seoDraft":{"ok":true,"skipped":false,...}}` when it creates a private draft
  - or `skipped:true` with reasons such as `quota_met`, `too_soon`, or `openai_not_configured`

3) Confirm the public endpoints:
- `https://stonegate-api.onrender.com/api/public/blog`

4) Confirm the site renders:
- `https://stonegatejunkremoval.com/blog`

## Controls / Ops

### Disable draft generation (optional)
- Set the compatibility env var on the worker: `SEO_AUTOPUBLISH_DISABLED=1`

### Adjust the draft-generation check interval (optional)
- Compatibility worker env var: `SEO_AUTOPUBLISH_INTERVAL_MS` (default ~6 hours)

### Manual generation and publishing

Use `/team/marketing/seo`. Human requests require a verified team session, `marketing.publish`, same-origin verification, and an idempotency key. `POST /api/admin/seo/run` only generates a private draft. Review and publish are separate, versioned and audited actions; publishing also requires typing the exact slug.

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
   - Optional. StonegateOS already has a lightweight first-party analytics system for `/book` (see `docs/web-analytics.md`).
   - If/when adding GA4, keep it minimal and avoid impacting performance on `/` and `/book`.

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
