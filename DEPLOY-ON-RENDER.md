# Deploying to Render

This repo includes a Render blueprint in `render.yaml` that provisions the site, API, and worker.

1. Commit `render.yaml` and push to the branch used for deployment.
2. In Render, choose **Blueprints -> New Blueprint** and point it at the StonegateOS repo/branch.
3. Render will provision:
   - Postgres `stonegate-db` (Basic 1GB, Virginia)
   - Web services `stonegate-site` and `stonegate-api`
   - Worker `stonegate-outbox-worker` (runs outbox + SEO autopublish)
4. Set environment variables before the first deploy.
   - All expected env vars are listed in `render.yaml` (with `sync: false` so they appear in the Render dashboard).
   - For a complete reference, also see `.env.example`.

   **Minimum required**
   - Site (`stonegate-site`)
     - `NEXT_PUBLIC_SITE_URL`
     - `NEXT_PUBLIC_API_BASE_URL`
     - `API_BASE_URL` (for server actions that need to call the API)
     - `ADMIN_API_KEY`
   - API (`stonegate-api`)
     - `ADMIN_API_KEY`
     - `API_BASE_URL` (public API URL)
     - Provider credentials as needed (Twilio, SMTP, OpenAI, Meta, Google Ads, etc.)
   - Worker (`stonegate-outbox-worker`)
     - Provider credentials to match what the worker should run (Twilio/SMTP/OpenAI/Meta/Google Ads)

   **Optional (tracking / ads)**
   - Meta pixel: `NEXT_PUBLIC_META_PIXEL_ID`
   - Google Ads tag: `NEXT_PUBLIC_GOOGLE_ADS_TAG_ID` (+ conversion `send_to` strings)

   **SEO-safe public branding (build-time)**
   - `NEXT_PUBLIC_COMPANY_*` values control the marketing site's name/phone/structured data without runtime API calls.
   - If you use a custom/BYO marketing site, these are optional; the CRM + API can still run from this repo.

5. Deploy the blueprint. The API runs `pnpm -w db:migrate` on deploy (see `render.yaml`).
6. Wait for `/api/healthz` on both web services to return `200 ok`.
7. Submit a live lead on the deployed site and confirm records in `contacts`, `leads`, and `outbox_events`.
8. Connect your custom domain to `stonegate-site` via Render DNS.
