# TA Platform Plan (Nextgen Treasury DAO / Tailored Agents)

This document is the source-of-truth for how StonegateOS evolves into a reusable, configuration-only product that Tailored Agents can deploy for multiple service businesses with minimal engineering effort.

## TL;DR
- Deployment model: **one deployment per company** (Stonegate, Myst, etc.).
- Customization model: CRM is **configuration-only** using a portable **Company Pack**; the marketing site is BYO/custom per company (kept SEO-fast).
- Engineering principle: company-specific values must not be hardcoded; they must come from configuration (DB + env).

## Vision
Build a repeatable operating system for local service businesses:
- Public marketing site + booking
- CRM/team console (`/team`) for sales/ops/owner workflows
- AI assistance (drafting, scoring, analytics) that is safe-by-default and operator-approved
- Integrations (Twilio, Meta, Google Ads, Google Business) per company deployment

## Non-goals (for now)
- True multi-tenant SaaS (shared DB across companies).
- Automated ad changes without operator approval.
- Building an in-product website builder / page-builder.

## Product model: Platform vs Company Pack
**Platform (shared codebase)**
- CRM: contacts, pipeline, appointments, reminders, tasks, outbox worker
- Unified inbox: SMS/DM/email threads, media, suggestions, drafts
- Ops: calendar, job completion, payments tracking, commissions
- Marketing: Google Ads sync + analyst dashboard
- Admin: roles, settings, audits, exports

**Company Pack (portable configuration)**
- Branding, phone numbers, hours, service area rules
- Pricing rules, discount policy, fees
- Pipeline labels/stages and automation defaults
- AI “voice”, templates, and knowledgebase pointers
- Optional: website template config (only if using the built-in marketing site template)

## Deployment model (TA chosen)
**One deployment per company**:
- Each company gets its own Render services (site, api, outbox worker) and its own Postgres DB.
- Company differences are applied by importing a Company Pack and setting env vars.

Why:
- Lowest operational risk for Stonegate (production stability).
- Simplest isolation for early customers.
- Still supports a “monthly hosting fee” product model.

## Roadmap (phased) + acceptance criteria

### Phase 0 — Production Discipline (safety)
**Goal:** Reduce risk while iterating on production workflows.
- Add a simple release checklist (dev/staging/prod).
- Define “must never break” flows and keep smoke tests for them.
- Add a standard “provider health” and “config health” page for support.

**Done when**
- There is a written release checklist.
- There are automated smoke tests for critical flows (or a documented manual test checklist if tests are not ready yet).

### Phase 1 — Company Pack (configuration-only portability)
**Goal:** Everything company-specific lives in Company Pack + env.

**Scope**
- Company Pack editor in `/team` + export/import JSON.
- Pack covers: branding, hours, service areas, pricing/discounts, pipeline labels, automation defaults, AI voice/templates.
- Export redacts secrets; secrets remain env-only.

**Done when**
- A new company deployment can be brought up without code edits:
  1) deploy
  2) set env secrets
  3) import Company Pack
  4) verify core flows
- No hardcoded “Stonegate” business text appears in customer-facing UI unless it comes from Company Pack.

### Phase 2 — Real user accounts + roles
**Goal:** Sellable CRM with real accountability and access control.

**Scope**
- Unique user accounts, memberships, roles/permissions (Sales/Ops/Owner/Admin).
- Team member accounts + roles + per-member permission overrides are implemented.
- Temporary legacy “break-glass” sessions (Owner/Crew keys) are still available during active development for safety.
- Before the system is considered “finished” (and sellable), remove/disable the legacy sessions and require per-user logins for accountability.
- Audit logs include actor user.

**Done when**
- “Who did what” is consistently attributable.
- Default assignee logic is driven by Company Pack (not hardcoded).
- Permissions prevent sensitive settings access for non-admin roles.

### Phase 3 — Bug & reliability sweep
**Goal:** Smooth operation; no “stale saving” behavior; predictable UI refresh.

**Scope**
- Tab-by-tab bug sweep for `/team` and booking flows.
- Standardize mutation feedback + cache invalidation patterns.
- Harden edge cases: duplicates, missing optional fields, out-of-area warnings, etc.

**Done when**
- Top recurring complaints are eliminated (saving states, stale reloads, incorrect sorting).
- Critical flows do not regress for 2 weeks of normal usage.

### Phase 4 — Professional UI/UX pass (Jobber/Markate feel)
**Goal:** High-quality, consistent UI/UX for customers and team console.

**Scope**
- Unified design system tokens (spacing, typography, colors, components).
- Mobile-first improvements for `/team` and inbox.
- Cleaner tables: fixed columns, responsive layouts, action areas that don’t overlap content.
- Website template polish for conversion.

**Done when**
- `/team` is fully usable on mobile without horizontal scrolling for core workflows.
- Buttons/typography/spacing are consistent across tabs.
- Website and `/book` have clear CTAs and trust signals.

### Phase 5 — Mobile “app” strategy (Samsung)
**Goal:** Great phone experience without multiplying codebases.

**Scope**
- Primary: PWA installability + mobile UX.
- Optional: Android wrapper (Capacitor/TWA) if needed for store distribution or push.

**Done when**
- `/team` is reliably usable on Android Chrome and can be “installed” as a PWA.
- Optional wrapper is only pursued if a real business need exists.

## Company Pack rules (important)
- Pack is **non-secret** and safe to export/share.
- Secrets are env-only (Twilio, Meta, Google Ads tokens, etc.).
- Pack includes a version and can evolve (migration-aware).
- Pack must be editable via UI for non-technical operators.

## Optional: Website template rules (if using the built-in template)
If Tailored Agents ships a template marketing site for a customer, treat it as a separate deliverable from the CRM product:
- Template-driven site reads branding from `NEXT_PUBLIC_COMPANY_*` at build time (SEO-safe).
- Allowed customization (no code): edit copy/headlines/CTAs and swap assets (logo/photos).
- Paid/custom work (TA add-on): full custom designs, new block types, or a BYO site integration.

## TA support + pricing model (recommended)
- Base subscription: hosting + monitoring + backups + platform updates.
- Add-ons:
  - custom web pages/design
  - advanced automation tuning
  - migration/CRM data import
  - custom integrations

## Next doc links
- Company Pack schema: `docs/company-pack.schema.json`
- TA Launch playbook: `docs/TA_LAUNCH_PLAYBOOK.md`
