# Deploying to Render

1. Commit `render.yaml` and push to the branch used for deployment.
2. In Render, choose **Blueprints → New Blueprint** and point it at the StonegateOS repository/branch.
3. Render will provision:
   - Postgres `stonegate-db` (Standard, Virginia)
   - Web services `stonegate-site` and `stonegate-api` (rename as desired)
   - Redis `stonegate-redis` (optional)
4. Set environment variables before the first deploy (all listed in `render.yaml` with `sync: false` so they surface in the dashboard):
   - Site (`stonegate-site`): `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_GA4_ID`, `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_APPOINTMENT_TIMEZONE`, `API_BASE_URL`, `ADMIN_API_KEY`
   - API (`stonegate-api`): `API_BASE_URL`, `ADMIN_API_KEY`, `NEXT_PUBLIC_SITE_URL`, `APPOINTMENT_TIMEZONE`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_WEBHOOK_URL`, `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `QUOTE_ALERT_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`
   - Shared defaults: `NODE_ENV=production`, `NODE_VERSION=20` (already specified), and `DATABASE_URL` is wired automatically from `stonegate-db`
5. Deploy the blueprint. `stonegate-api` runs `pnpm -w db:migrate` on each deploy.
6. Wait for `/api/healthz` on both services to return `200 ok`.
7. Submit a live lead on the deployed site and confirm records in `contacts`, `properties`, `leads`, and `outbox_events`.
8. Connect your custom domain to `stonegate-site` via Render DNS.
