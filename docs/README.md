# Docs

This folder contains operational, planning, audit, and historical documentation for the monorepo. Phase 1 reconciled the canonical repository documentation, but older historical files may still describe superseded states; do not treat every file as current production truth.

## Active Alignment Program

- Canonical phased plan: [StonegateOS System Alignment and Demo Readiness Plan](STONEGATE_SYSTEM_ALIGNMENT_PLAN.md)
- Current architecture: [StonegateOS Current System Overview](CURRENT_SYSTEM_OVERVIEW.md)
- Desktop/mobile ownership: [StonegateOS Capability Matrix](CAPABILITY_MATRIX.md)
- Read-only/live evidence ledger: [StonegateOS Production Baseline](PRODUCTION_BASELINE.md)
- Active operational risks: [StonegateOS Operational Risk Register](OPERATIONAL_RISK_REGISTER.md)
- Latest local readiness evidence: [Phase 1 audit — 2026-10-10](audits/system-alignment-phase-1-2026-10-10.md)
- Current desktop foundation evidence: [Phase 2 desktop audit — 2026-10-10](audits/system-alignment-phase-2-desktop-foundation-2026-10-10.md)

This plan governs the safe alignment of the live desktop and mobile products, documentation reconciliation, productization, prospect-demo readiness, and later visual polish. Older plans and audits remain useful evidence but must not override its current status or safety rules.

## Start Here (Production)

- Current architecture and verification status: `CURRENT_SYSTEM_OVERVIEW.md`
- Current capability/parity map: `CAPABILITY_MATRIX.md`
- Deploy on Render: `../DEPLOY-ON-RENDER.md`
- Critical production flows: `CRITICAL_FLOWS.md`
- Release checklist + smoke checks: `RELEASE_CHECKLIST.md`
- Appointment photos + Square rollout: `APPOINTMENT_MEDIA_SQUARE_RUNBOOK.md`
- Stability audit checklist (ads + daily ops): `STABILITY_AUDIT.md`
- Source-derived system indexes and documentation: `system/README.md`

## Operations

- Commission policy: `COMMISSION_POLICY.md`
- Outbox worker (background jobs): `outbox-worker.md`
- SEO agent (autopublishing blog): `seo-agent.md`
- Meta (Facebook) setup: `meta-facebook-setup.md`

## Marketing

- Google Ads sync + analyst: `marketing.md`
- Website analytics (first-party): `web-analytics.md`

## Productization (Tailored Agents)

- Productization target-state plan: `PRODUCTIZATION_PLAN.md`
- Platform target-state plan: `TA_PLATFORM_PLAN.md`
- Draft launch playbook (new company deployment): `TA_LAUNCH_PLAYBOOK.md`
- Company Pack schema + inventory (portability work):
  - `company-pack.schema.json`
  - `company-pack-inventory.md`

Target direction: the CRM and automations should support configuration-led onboarding. Company Pack and hardcode-removal work is not yet complete; see the active alignment plan before making portability claims. The marketing site can be customized per customer or replaced with a BYO site.

## Archived Docs

Older plans and historical notes live in `archive/`.
