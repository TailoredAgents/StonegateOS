# Partner invitation activation recovery — September 10, 2026

## Incident and production evidence

The owner reported that the LandL Sourdough test invitation reached an activation
page saying the link could not be checked. No real invitation token, password,
session credential, or recipient address was retrieved during diagnosis.

Two separate failures were identified:

1. **Activation disabled:** API request logs at `2026-09-10T12:19:47Z` show
   invitation acceptance returning `202`, immediately followed by activation
   inspection returning `503`. Inspection's purpose-auth gate was disabled.
   Invitation acceptance did not check that gate before consuming the invitation.
2. **Wrong inspection origin:** after enabling activation, the deployed Site still
   received `403` for inspection. A synthetic malformed cookie, not a real token,
   reproduced this through the Site at `2026-09-10T20:57:11Z`. The Site asserted
   the external API transport origin; the API instead recognizes its internal
   request origin and its configured public Site origins. A safe empty-body API
   check using `https://stonegatejunkremoval.com` reached credential validation
   (`401`), while the external API origin was rejected (`403`).

## Applied production configuration

With the owner's authorization, merged only
`PARTNER_PORTAL_PURPOSE_AUTH_ENABLED=true` into `stonegate-api` on Render.
No other environment variables were replaced. Render automatically redeployed
existing commit `ff50cbc13f9411156953a08ef303ae590f66f11c` as
`dep-dahhg91594qs73afugrg`; it became live at `2026-09-10T20:55:15Z`.
The former `503` gate is cleared. The outbox worker does not use this flag, so
its configuration was not changed.

**The origin correction below is local and not yet deployed. Activation is not
certified as working end to end. Do not resend until the code fix is deployed
and its Site-to-API smoke check passes.**

## Local remediation

- `apps/site/src/app/partners/lib/activation-inspection.ts`: resolve the origin
  from validated operator-configured `NEXT_PUBLIC_SITE_URL` / `SITE_URL`, not
  the API transport URL or incoming browser/proxy headers. Missing or unsafe
  production configuration fails closed. Keep the existing trusted-hop IP and
  bounded user-agent policy; do not forward browser credentials or fetch metadata.
- `apps/site/src/app/partners/(public)/activate/page.tsx`: require that configured
  origin before sending the token-bearing inspection request.
- `apps/api/app/api/portal/v2/invitations/accept/route.ts`: reject acceptance with
  `503 service_unavailable` while activation is disabled, before rate-limit,
  invitation consumption, identity/membership creation, or derived-token lookup.
- Leave API origin protections, password validation, account isolation, token
  expiry, and issuer revalidation intact. No MFA is introduced.

## Verification

- Site invitation, origin, and native credential-form tests: **17 passed**.
  Includes configured-origin selection, hostile-header exclusion, missing/invalid
  production configuration, retry/cookie behavior, and native POST forms.
- API activation, verification, and onboarding-origin tests: **16 passed**.
  Includes the real origin validator with a different internal API authority,
  and continued rejection of attacker origins and cross-site requests.
- Acceptance-readiness and related API regression run: **25 passed across four
  suites**. Covers disabled production flags before any credential handling,
  enabled handoff/retries, expiry, origin, idempotency, and rate limits.
- Site and API typechecks passed; focused API route/test lint passed; `git diff
  --check` passed. No real recipient journey is claimed.
- Production smoke checks used only empty bodies or malformed synthetic tokens.
  No real activation was inspected or completed; no account was created or merged.

## Invitation recovery and remaining release work

1. Confirm the Site's configured public origin matches a configured origin on
   the API, deploy the local code correction, and repeat the synthetic Site
   inspection check. Expect `401` for a deliberately malformed token, not `403`
   or `503`.
2. From an authenticated owner CRM session, open **Partners → LandL Sourdough →
   People & invitations → Invitations → Send a new invitation**.
3. Open only the newest email. The email invitation lasts seven days; after
   continuing to password setup, the activation credential lasts 30 minutes.
4. Verify company/email, submit the password, and confirm the correct job home.

The automation connection has no authenticated human Team session and has **not
resent the invitation**. The canonical staff resend API requires that session,
current invitation ETag, and an idempotency key. Do not fabricate a session,
modify account records directly, use the legacy activation-resend endpoint, or
recreate the company. Canonical invitation resend preserves the invited person
and membership while invalidating old invitation and unfinished setup links.
