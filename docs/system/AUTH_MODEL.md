# Auth + Permissions Model

StonegateOS has distinct auth systems for:
- Staff (Team Console)
- Partners (Partner Portal)
- Machine-to-machine agent integrations (Discord Jarvis, future agents)
- Provider webhooks (Twilio/Meta/Email)

This doc describes what exists today and where it is enforced.

---

## 1) Admin API key (service-to-service)

Many API routes require the `ADMIN_API_KEY` header:
- Gate: `StonegateOS/apps/api/app/api/web/admin.ts`
- Header accepted:
  - `x-api-key`
  - `x-admin-api-key`
  - `authorization` (supports `Bearer <key>`)

This is used primarily by:
- Team Console server actions / internal calls
- Agent routes that “act as admin”

Operational note:
- This is powerful. Treat it like a root secret.

---

## 2) Team member sessions (staff login)

Team session helpers:
- `StonegateOS/apps/api/src/lib/team-auth.ts`

Key tables:
- `team_members`
- `team_roles`
- `team_login_tokens` (magic links)
- `team_sessions` (active sessions)

High-level flow:
1. A login link/token is created for a team member (email or phone).
2. Token is exchanged into a session (stored hashed in DB).
3. Requests carry the session token (cookie/header depending on caller).

Some endpoints instead use “break-glass”/legacy sessions on the Site side during development:
- Mentioned in `StonegateOS/README.md` (crew/owner keys via `apps/site/src/lib/crew-session.ts`)

---

## 3) Role + permission enforcement (Team Console)

Permission helpers:
- `StonegateOS/apps/api/src/lib/permissions.ts`

Key behaviors:
- Effective permissions come from:
  - role permissions (`team_roles.permissions`)
  - per-member grants/denies (`team_members.permissionsGrant/permissionsDeny`)
- Owners always resolve to full access (`*`).
- `requirePermission(request, ...)` returns `403 forbidden` JSON when lacking permissions.

Many `/api/admin/*` endpoints do both:
1) `isAdminRequest` (API key)
2) `requirePermission` (role/permission gates)

---

## 4) Partner sessions (partner portal)

Partner auth helpers:
- `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`

Key tables:
- `partner_users`
- `partner_login_tokens`
- `partner_sessions`
- `partner_rate_cards`, `partner_rate_items`, `partner_bookings`

High-level flow:
1. Partner is invited (a `partner_users` row exists and is active).
2. Partner requests a link or logs in with password (depending on configuration).
3. Token exchange creates a long-lived partner session.
4. Portal endpoints (`/api/portal/*`) require the session.

Anti-enumeration behavior:
- Some “request link” endpoints can respond with “sent” even if the user doesn’t exist to avoid account enumeration.

---

## 5) Agent-to-API auth (Jarvis)

Machine-to-machine “shared secret” (used by Discord Jarvis and future agents):
- Env: `AGENT_BOT_SHARED_SECRET` (must match between agent + site/api endpoints it calls)

Entry:
- Discord agent worker: `StonegateOS/scripts/discord-agent-bot.ts`

Important design principle:
- Sensitive actions should be approval-gated.
- The agent should not rely only on Discord identity; server-side should validate permissions and intent TTL.

---

## 6) Provider webhooks

Provider webhooks do not use the admin key.
They should validate provider signatures/tokens where possible (Twilio/Meta) and be tolerant to retries/duplicates.

Webhook directories:
- Twilio: `StonegateOS/apps/api/app/api/webhooks/twilio`
- Meta: `StonegateOS/apps/api/app/api/webhooks/facebook`
- Email: `StonegateOS/apps/api/app/api/webhooks/email`
- DM: `StonegateOS/apps/api/app/api/webhooks/dm`

