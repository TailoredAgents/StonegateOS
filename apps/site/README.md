# Stonegate Site App

Supported public, office, field, customer-proposal, and Partner experiences for StonegateOS.

## What lives here

- Marketing pages under `apps/site/src/app/(site)`.
- Team Console under `apps/site/src/app/team` with canonical route and permission ownership in `surface-registry.ts`.
- Protected field application under `apps/site/src/app/mobile`.
- Partner Portal under `apps/site/src/app/partners` and customer Quote V2 surfaces under the Site routes.
- Public chat + booking flow at `apps/site/src/app/api/chat/route.ts`.
- Team authentication and verified sessions for `/team` and `/mobile`.

## Local Development

From the repo root:

```bash
pnpm --filter site dev
```

The site runs at `http://localhost:3000` by default.

## Environment Variables

Required for full functionality:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_API_BASE_URL`
- `API_BASE_URL`
- `ADMIN_API_KEY`

Optional:

- `OPENAI_API_KEY`, `OPENAI_MODEL` (public chat)
- `NEXT_PUBLIC_GA4_ID`, `NEXT_PUBLIC_META_PIXEL_ID`

Team Console timestamps are fixed to Eastern (`America/New_York`) with automatic daylight savings; no timezone env is required.

## Content

Markdown/MDX content lives under `apps/site/content`. The site uses Contentlayer during build; see root README for build steps.

For operational docs (deploy, release checklist, integrations), start at `docs/README.md`.
