# Productization Plan (Phased)

Goal: make this repo easy to deploy for multiple service businesses on Render, with minimal code changes between companies (config-only where possible), while keeping the public site fast/SEO-safe.

## Phase 0 — Foundation (Render-first, safe defaults)
- Keep marketing pages SEO-safe: public branding comes from `NEXT_PUBLIC_COMPANY_*` env vars at build time (no runtime DB fetch on public pages).
- Keep internal operations configurable: policies, automations, and AI templates come from Policy Center (DB-backed).
- Document the “new company on Render” workflow and required env vars.

## Phase 1 — “Company Pack” (Config-only portability)
- Define a single JSON “Company Pack” that captures:
  - identity, phone/email/logo, business hours, service area rules
  - sales automations + autopilot templates
  - AI persona/knowledge prompts and guardrails
  - partner/ops defaults as needed
- Add export/import in Team Console (owner-only) + a validation step against `docs/company-pack.schema.json`.
- Add a Render env snippet generator for `NEXT_PUBLIC_COMPANY_*` values (public site).

## Phase 2 — Bug/UX Audit (stability)
- Systematically walk every tab/page for:
  - save states that require refresh
  - stale data, loading ordering, error boundaries
  - mobile layout issues
- Add lightweight automated checks where patterns repeat (smoke tests).

## Phase 3 — Professional UX (website + /team)
- Website: conversion-oriented landing UX (fast, clean, trust signals, clear CTA).
- Team Console: polish spacing, typography, table layouts, and mobile usability.
- Maintain “no perf regressions” for public pages.

## Phase 4 — Per-user Accounts + Permissions
- Replace the shared “master login” with team member accounts.
- Per-role permissions and audit logging of actions.
- Tie sales attribution and coaching to the authenticated user.

## Phase 5 — Mobile App (Samsung-friendly)
- Ship a PWA-first experience (offline-safe, push notifications, home-screen install).
- Only build a native wrapper if needed after PWA proves out.
