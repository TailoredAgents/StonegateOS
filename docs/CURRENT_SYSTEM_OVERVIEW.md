# StonegateOS Current System Overview

> Canonical architecture overview. Update this document when supported applications, deployment topology, authentication, or major workflow ownership changes. Historical plans and dated audits provide context but do not override this file.

## Verification status

| Field                                 | Value                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Source reviewed                       | 2026-10-10 at repository revision `c2e09ea8` plus the current Phase 1 worktree |
| Production revisions                  | Must be captured through the Phase 0 live-environment gate                     |
| Protected-route runtime certification | Open; no signed-in interactive browser was connected during this update        |
| Data changes performed                | None                                                                           |
| Operational model                     | One isolated deployment and Postgres database per company                      |

Source verification establishes what the repository implements. It does not prove that a feature flag, provider, migration, or protected workflow is active and healthy in a particular deployment.

## What StonegateOS is

StonegateOS is the operating platform used by Stonegate Junk Removal. It combines:

- A public marketing, instant-quote, and booking website.
- A desktop office application at `/team`.
- A protected phone-first field application at `/mobile`.
- A customer proposal experience for Quote V2.
- A Partner Portal and matching staff workspace.
- A Next.js API service that owns database-backed business logic and webhooks.
- An outbox worker for durable notifications, provider work, document work, and scheduled automation.
- An optional Discord agent worker with approval-gated actions.

The active product is the public/Site application, `/team`, `/mobile`, Partner Portal, API, and workers. The separate `apps/app` Owner Hub is experimental legacy work and is not a supported demo or product surface.

## Production topology

The Render blueprint defines the deployed topology:

| Service                   | Code                                          | Responsibility                                                                                               |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `stonegate-site`          | `apps/site`                                   | Public website, booking, customer quote UI, `/team`, `/mobile`, Partner Portal, and Site proxy/server routes |
| `stonegate-api`           | `apps/api`                                    | PostgreSQL access, domain operations, admin/public APIs, provider webhooks, readiness, and business rules    |
| `stonegate-outbox-worker` | `scripts/outbox-worker.ts` plus API libraries | Durable outbox processing, retries, scheduled work, notifications, documents, and provider dispatch          |
| `stonegate-discord-agent` | `scripts/discord-agent-bot.ts`                | Optional approval-gated operational assistant                                                                |
| `stonegate-db`            | PostgreSQL                                    | Company-isolated operational data and durable evidence                                                       |

The repository currently targets one company per deployment. It is not documented or certified as a shared-database multi-tenant SaaS.

## Supported user experiences

### Public and customer

- Marketing and service content under the Site application.
- Public quote/booking flows under `/book` and related routes.
- Signed customer Quote V2 pages and proposal decisions.
- Provider-backed notifications and reminders through the API/outbox boundary.

### Team Console (`/team`)

`apps/site/src/app/team/surface-registry.ts` is the navigation source of truth. It defines canonical paths and permission gates for 23 surfaces, including:

- Daily work: Calendar, Inbox, Contacts, Quotes, and Expenses.
- Sales: Pipeline, Sales HQ, Partner Outreach, Partners, and Sales Activity.
- Marketing: Ads, Website Analytics, and SEO.
- Owner: Owner HQ.
- Administration: Policy Center, Messaging Automation, Commissions, Access, Audit Log, and Merge Queue.
- Tools and personal: Agent, Simulator, and Settings.

The supported route model uses canonical paths such as `/team/calendar` and `/team/inbox`. The older `?tab=` query is compatibility behavior, not the primary navigation contract.

### Mobile (`/mobile`)

Mobile is a dedicated, protected field experience within `apps/site`, not a separate deployment. Its permission-derived screens include Inbox, Today/My Day, Partners, People, Calendar, Quotes, Spend, Owner, Access, and More/Settings.

Mobile is the reference implementation for established crew workflows:

- Assigned work and daily job execution.
- Customer call/message/directions actions.
- Quoted scope and job context.
- Appointment media and proof capture.
- Payment collection and history where enabled.
- Completion drafts, retry, and bad-signal recovery.
- Spend/receipt capture, offline queueing, and submission.

Alignment work must preserve these workflows unless a reviewed change explicitly improves them.

### Partner Portal

Partner Portal supports company/account access, locations, requests, job tracking, media/proof, commercial workflows, approvals, billing history, and staff handoff. Partner work has a dedicated production-release workflow in addition to the general quality lane.

## Core operating flow

```text
Customer inquiry or booking
  -> Inbox and Contact/Property record
  -> Quote and customer decision
  -> Calendar scheduling and resource planning
  -> Mobile crew execution
  -> Media, payment, expense, and completion evidence
  -> Owner, financial, partner, and reporting views
```

## Data and asynchronous work

- Drizzle schema: `apps/api/src/db/schema.ts`.
- Production migrations: `apps/api/drizzle` and the migration runner referenced by `render.yaml`.
- Generated structural inventory: `docs/system/DATA_DICTIONARY_COLUMNS.md`.
- Durable asynchronous work: `outbox_events`, processed by the outbox worker and specialized workers.
- Generated literal event inventory: `docs/system/OUTBOX_EVENT_INDEX.md`.

Do not infer safe deletion, retention, or migration behavior from a generated column list. Operational changes require schema, migration, relationship, worker, audit, and rollback review.

## Authentication and authorization

- Individual Team accounts and verified Team sessions are the supported accountability model.
- UI visibility is not authorization; API and Site mutation boundaries must enforce permissions.
- `/team` surface gates come from the Team surface registry.
- `/mobile` derives allowed screens from the same Team member permissions, with mobile-specific workflow gates.
- Partner users have a separate portal access model.
- Legacy break-glass access remains an operational fallback during development and must not be presented as the final sellable access model.

## Operational feature flags

Important capabilities are fail-closed or deployment-controlled. Relevant examples include:

- Appointment media writes and public quote media uploads.
- Mobile offline media.
- Quote V2 staff, sender, public, mutation, deposit, and booking stages.
- Mobile booking-card V2 behavior.
- Mobile Square payments.

Source presence does not prove deployment enablement. Before a demo or release, record effective flag state without printing secrets.

## Deployment and migrations

- Node.js 20 and pnpm 9.15.9 are the supported toolchain.
- `render.yaml` is the deployment configuration source of truth.
- The API pre-deploy command requires an explicit `DB_MIGRATION_TARGET` of `0058_appointment_media`, `0059_square_payments`, or `latest`.
- Prefer additive migrations and forward fixes. Never reset or reseed the live Stonegate database as part of application alignment.
- Every production change requires a rollback path and proportional smoke evidence.

## Documentation authority

| Question                          | Current authority                                |
| --------------------------------- | ------------------------------------------------ |
| Program order and safety gates    | `STONEGATE_SYSTEM_ALIGNMENT_PLAN.md`             |
| Current architecture              | This document                                    |
| Desktop/mobile ownership and gaps | `CAPABILITY_MATRIX.md`                           |
| Production deployment gate        | `RELEASE_CHECKLIST.md` and `DEPLOY-ON-RENDER.md` |
| Route/schema/outbox inventory     | Generated files in `docs/system`                 |
| Feature-specific operations       | The relevant runbook                             |
| A particular deployed release     | A dated, commit-specific release audit           |

Historical plans remain useful evidence. They must be labeled as historical when their status no longer matches current code.

## Known alignment work

- Complete Phase 0 live revision, flag, rollback, backup, and signed-in runtime evidence.
- Bring the desktop appointment workspace up to mobile job-execution visibility and action parity.
- Bring desktop Expenses up to Mobile Spend V2 and correct submitter/approver permission alignment.
- Align terminology, branding, status presentation, and cross-shell handoffs without redesigning mobile.
- Remove customer-facing Stonegate hardcodes before claiming configuration-only onboarding.
- Retire break-glass access only after individual-account recovery and operational fallback are proven.
- Repair stale test assertions while keeping the general workflow red until real failures are resolved.

## Development and verification entry points

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:ratchet
pnpm test
pnpm docs:check
pnpm build
pnpm test:e2e
pnpm test:e2e:team-audit
```

Use Node.js 20. The full hermetic browser stack additionally requires the repository's Docker-based E2E services and seeded test environment.
