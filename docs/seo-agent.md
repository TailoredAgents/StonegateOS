# SEO Agent (Autopublishing Blog) + Next Steps Plan

This repo includes a v1 “SEO agent” that **autopublishes blog posts** and makes them indexable (routes + sitemap). This doc explains what’s implemented, how to verify it’s running, and what’s still needed for “full SEO” (measurement, local SEO, technical SEO, and safe authority building).

## What’s Implemented (v1)

### Autopublishing blog posts (2/week target)
- A background job runs inside the existing Render worker (`stonegate-outbox-worker`) and periodically attempts to publish blog content.
- The agent is intentionally **safe-by-default**:
  - No automated backlink blasts.
  - No fabricated stats/awards/partnerships.
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
- Max **2 posts per 7 days**
- Minimum spacing of about **3 days** between posts (prevents bursts)
- Uses a Postgres advisory lock to avoid double-publishing if multiple worker instances run.

### Models used (“best of both”)
- “Brain” model for brief/strategy: uses `OPENAI_MODEL` (defaults to `gpt-5-mini`)
- “Voice” model for the final Markdown copy: `gpt-4.1-mini`

## How To Verify It’s Running

1) Confirm tables exist (after API deploy/migrations):
- `blog_posts`
- `seo_agent_state`

2) Confirm the worker is deployed and running:
- Render → `stonegate-outbox-worker` → Logs
- Look for periodic JSON logs like:
  - `{"ok":true,"seo":{"ok":true,"skipped":false,...}}` when it publishes
  - or `skipped:true` with reasons such as `quota_met`, `too_soon`, or `openai_not_configured`

3) Confirm the public endpoints:
- `https://stonegate-api.onrender.com/api/public/blog`

4) Confirm the site renders:
- `https://stonegatejunkremoval.com/blog`

## Controls / Ops

### Disable autopublishing (optional)
- Set env var on the worker:
  - `SEO_AUTOPUBLISH_DISABLED=1`

### Adjust the autopublish check interval (optional)
- Worker env var:
  - `SEO_AUTOPUBLISH_INTERVAL_MS`
- Default is ~6 hours.

### Manual run (admin-only)
There is an admin endpoint you can call (use `x-api-key: ADMIN_API_KEY`):
- `POST /api/admin/seo/run` with JSON `{ "force": true }`

## What’s Still Needed for “Full SEO”

The blog agent is only one piece. Rankings generally move from a combination of:

1) **Measurement & indexing**
2) **Local intent coverage (service + area pages)**
3) **Technical SEO**
4) **Legit authority (citations, reviews, real mentions/links)**

Below is a practical plan to finish this up.

---

# Phase 1 — Measurement & Indexing (do this next)

## 1) Google Search Console (GSC)
Goal: see what you rank for, fix indexing issues, submit sitemap.

Steps:
1) Create/Log in to Google Search Console.
2) Add a **Domain** property for `stonegatejunkremoval.com` (DNS verification recommended).
3) Submit sitemap: `https://stonegatejunkremoval.com/sitemap.xml`
4) Confirm key pages are indexed: `/`, `/services/*`, `/areas/*`, `/blog/*`

## 2) Google Analytics 4 (GA4)
Goal: track conversions (quote → booking, call clicks, etc.).

Notes:
- Render already includes `NEXT_PUBLIC_GA4_ID` in the `stonegate-site` env list, but the site currently does not inject the GA tag automatically.

Implementation plan:
1) Add GA4 script injection in `apps/site/src/app/layout.tsx` (or a shared analytics component) gated by `process.env.NEXT_PUBLIC_GA4_ID`.
2) Standardize events:
   - `quote_start`
   - `quote_success`
   - `booking_success`
   - `call_click`
   - `sms_click`
3) Verify events in GA4 real-time.

---

# Phase 2 — Local SEO Foundations (high ROI)

## 1) Google Business Profile (GBP)
This is usually the #1 driver of local leads.
- Claim/verify GBP
- Ensure NAP consistency (name, address, phone)
- Add services, photos, service areas, hours
- Start a review ask process (SMS/email follow-up)

## 2) Citations (safe “backlinks”)
Do NOT do spam link farms. Focus on legit listings:
- Apple Maps, Bing Places, Yelp, Angi, Thumbtack, Nextdoor, local chambers, etc.

Automation plan (safe):
- Build a weekly “citation/outreach task generator” that creates CRM tasks (`crm_tasks`) rather than auto-posting.
  - Example: “Create/verify Yelp profile”, “Update Bing Places hours”, “Request 5 reviews this week”.

---

# Phase 3 — On-Page SEO (service + city/area coverage)

Blog posts help, but local junk removal typically ranks best with strong service + city pages.

Plan:
1) Expand `/services/*` pages:
   - add FAQs
   - add LocalBusiness/Service schema
   - add internal links to relevant blog posts
2) Expand `/areas/*` pages:
   - create more city pages within your real service footprint
   - avoid duplicate/thin pages; each should have unique details + FAQs
3) Build internal linking rules:
   - each blog post links to 2–4 service pages + scheduling CTA
   - each service page links to 2–4 blog posts

---

# Phase 4 — Technical SEO

Plan:
1) Add `LocalBusiness` JSON-LD sitewide (in layout) with:
   - business name, phone, service area (counties), URL
2) Confirm canonical tags for key pages (already done via metadata helpers for most)
3) Monitor Core Web Vitals and fix regressions
4) Ensure `robots.txt` and sitemap are correct (already present)

---

# Phase 5 — “Smarter” SEO Agent (after GSC has data)

Once Search Console has data (usually 2–4 weeks), evolve the agent from a static topic list to data-driven:

1) Pull top queries/pages from GSC (API or manual export).
2) Topic selection heuristic:
   - prioritize queries with impressions but low CTR/position (easy wins)
   - prioritize high-converting intents (pricing, cleanouts, mattresses, yard waste)
3) Add a “content QA” step:
   - prevent thin/duplicate posts
   - enforce style + factual constraints

Optional:
- Add a lightweight `/team` “SEO status” panel showing:
  - last publish time
  - last publish result
  - upcoming topic
  - posts this week

---

## What Not To Do
- Don’t buy bulk backlinks or auto-submit to random directories.
- Don’t publish dozens of near-duplicate area pages.
- Don’t let AI invent stats/awards or promise exact prices.

