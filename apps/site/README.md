# Stonegate Site App

Public marketing site plus the Team Console UI.

## What lives here
- Marketing pages under `apps/site/src/app/(site)`.
- Team Console under `apps/site/src/app/team` (estimates, quotes, pipeline, contacts, calendar, owner tools).
- Public chat + booking flow at `apps/site/src/app/api/chat/route.ts`.
- Admin login at `/admin/login` (sets the session cookie used by the Team Console).

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
- `NEXT_PUBLIC_APPOINTMENT_TIMEZONE`

## Content
Markdown/MDX content lives under `apps/site/content`. The site uses Contentlayer during build; see root README for build steps.
