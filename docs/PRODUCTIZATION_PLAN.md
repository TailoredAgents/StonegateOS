# Productization Plan (Phased)

Goal: make the CRM + automations easy to deploy for multiple service businesses on Render, with minimal code changes between companies (config-only where possible), while keeping the public marketing site SEO-safe.

Product decision:
- The CRM is the product (config-only onboarding).
- The marketing site is expected to be customized per customer (or BYO site). The repo’s built-in marketing site can be used as a starter template, but portability should not depend on templating the entire marketing site.

## Phase 0 — Foundation (Render-first, safe defaults)
- Keep marketing pages SEO-safe: public branding comes from `NEXT_PUBLIC_COMPANY_*` env vars at build time (no runtime DB fetch on public pages).
- Keep internal operations configurable: policies, automations, and AI templates come from Policy Center (DB-backed).
- Document the “new company on Render” workflow and required env vars.

## Phase 1 — CRM “Company Pack” (Config-only portability)
Define a single JSON “Company Pack” for the CRM and automations (not the marketing site) that captures:
- identity: company name, phones, emails, hours
- service area rules (cities/ZIPs) used by lead qualification + messaging warnings
- sales automations + autopilot templates + escalation behavior
- AI persona/knowledge prompts and guardrails
- partner/ops defaults as needed (rates, booking windows, etc.)

Deliverables:
- Owner-only export/import in Team Console + validation against `docs/company-pack.schema.json`.
- A “Company Pack seed” that can be pasted into a new deployment (fast onboarding).

Optional:
- A Render env snippet generator for `NEXT_PUBLIC_COMPANY_*` values (only if using the built-in marketing site template).

## Phase 2 — Bug/UX Audit (stability)
- Systematically walk every tab/page for:
  - save states that require refresh
  - stale data, loading ordering, error boundaries
  - mobile layout issues
- Add lightweight automated checks where patterns repeat (smoke tests).

## Phase 3 — Professional UX (Team Console first)
- Team Console: polish spacing, typography, table layouts, mobile usability, and common workflows.
- Marketing site: only if/when we want the repo’s template to be a baseline offering.
- Maintain “no perf regressions” for public pages.

## Phase 4 — Per-user Accounts + Permissions
- Replace the shared “master login” with team member accounts.
- Per-role permissions and audit logging of actions.
- Tie sales attribution and coaching to the authenticated user.

## Phase 5 — Mobile App (Samsung-friendly)
- Ship a PWA-first experience (offline-safe, push notifications, home-screen install).
- Only build a native wrapper if needed after PWA proves out.
