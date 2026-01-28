# Local SEO Performance Baseline (Site)

This doc is the speed guardrail for local SEO work. The goal is to improve local rankings without slowing the customer-facing site.

## What we measure (fast, repeatable in CI/dev)

- `next build` route sizes (First Load JS) for key pages.
- Total size of `.next/static/chunks` (JS/CSS) and the largest chunk files.
- Total size of `apps/site/public/images` and the largest images.

This is not a replacement for Lighthouse/Web Vitals, but it catches most accidental regressions (new client bundles, heavy libraries, huge images, etc.).

## Run the baseline report

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-site-perf.ps1
```

The script writes a dated report into `docs/archive/` and prints the path at the end.

## Local SEO performance rules of thumb (for this repo)

- Keep city/area pages static MDX (no new client JS, no embeds).
- Do not add Leaflet/maps to every city page (keep the map isolated to `/areas`).
- Prefer server components + plain `<Link>` lists for internal linking blocks.
- Add JSON-LD only where it’s useful (don’t bloat sitewide schema).
- Avoid adding new analytics/trackers unless they replace something else.

