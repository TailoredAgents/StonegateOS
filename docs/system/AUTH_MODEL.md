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

1. `isAdminRequest` (API key)
2. `requirePermission` (role/permission gates)

---

## 4) Partner identities, memberships, and sessions

Partner authentication and authorization helpers:

- `StonegateOS/apps/api/src/lib/partner-portal-auth.ts`
- `StonegateOS/apps/api/src/lib/partner-purpose-auth.ts`
- `StonegateOS/apps/api/src/lib/partner-account-authorization.ts`

Key records:

- `partner_users` — one global normalized-email identity; never a source of
  account authority by itself
- `partner_accounts` — the tenant boundary
- Partner-managed organization, service-contact, and billing-contact/address
  fields live directly on `partner_accounts` behind an independent profile
  revision. They are account data, never identity, membership, CRM-contact,
  pricing, or payment-provider authority.
- `partner_account_memberships` plus relational location/cost-center scopes —
  the only portal account authority
- `partner_auth_challenges` and `partner_applicant_sessions` — purpose-bound
  email verification, activation, reset, and sign-in-email-change credentials
  with no account capabilities
- `partner_auth_transactions` — short-lived, one-use password-login or
  privileged-activation pre-authentication records bound to the identity,
  selected account/membership, security version, remember-me choice, IP, and
  user agent; their hashed bearer is not a portal session
- `partner_sessions` — revocable server sessions with a selected account and
  membership, security version, assurance, and aligned expiry

High-level flow:

1. An applicant verifies their mailbox through a one-use purpose-bound link.
   This creates only an applicant session, not a partner identity, tenant,
   membership, CRM contact, or portal authority.
2. Stonegate approves a new company application, or an authorized company
   Administrator/Stonegate reviewer approves a verified existing-company join.
   Approval provisions the canonical identity/account/membership in an invited
   activation state and queues a separate activation link.
3. Activation sets a 15–128 character password using versioned asynchronous
   Argon2id. For an Administrator or Billing/Approver, password confirmation
   consumes the email link but leaves the new identity inactive and membership
   invited. It returns only a transaction-authorized authenticator setup state.
   TOTP confirmation atomically enrolls the method, creates single-use recovery
   codes, activates identity and membership, and issues the first AAL2 session.
   An existing identity with TOTP verifies that method (or a recovery code)
   without replacing it. Migrated scrypt hashes are verified and rehashed after
   a successful password login.
4. Administrator and Billing/Approver memberships require TOTP MFA. Password
   success for any MFA-required or already-enrolled identity creates only a
   short-lived `partner_auth_transaction`; it creates no session and grants no
   Portal API access. TOTP or a single-use recovery code consumes that record
   and creates the AAL2 session atomically. Missing enrollment fails closed to
   audited account recovery rather than issuing AAL1 authority.
5. Every Portal V2 request resolves a `PartnerPrincipal` from the active
   identity, selected operational account, active membership, relational
   scopes, effective role capabilities, security version, and session. Tenant
   or scope substitutions return an opaque `404` at resource boundaries.
6. A sign-in-email change starts only from an authenticated settings session.
   MFA-required users need MFA verified within 15 minutes; other users need a
   recent password session or their current password. The one-use link proves
   the new mailbox, rotates the identity security version, revokes every
   session and outstanding auth credential, and never creates a session or CRM
   record.
7. Any active membership with `account.read` may read the selected account's
   organization/service profile. Billing contact/address and PO/cost-center
   guidance are redacted unless the membership has `commercial.edit` or
   `invoices.read`. Account-wide `account.update` is required for
   organization/service-contact changes, while account-wide `commercial.edit`
   is required for billing-contact/address and PO/cost-center guidance. A
   mixed mutation requires both; scoped memberships and required MFA that is
   missing, not AAL2, or older than 15 minutes fail closed. Every write uses a locked account row and strong
   `If-Match` revision without changing capabilities.

Routine sign-in is email plus password. Email links are limited to mailbox
verification, activation, invitations, password reset, and sign-in-email
change confirmation. Routine magic-link
login is dormant behind an off-by-default flag, absent from production UI, and
must never be used as an authentication or rollback fallback. Phone numbers do
not authenticate partner users; SMS notification delivery requires a separate
verified opt-in.

Unknown login and recovery requests use neutral responses and do not create CRM
leads, contacts, applications, or tasks.

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
