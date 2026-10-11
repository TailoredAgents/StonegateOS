# StonegateOS Production Baseline

> Phase 0 evidence ledger. This document records what can be verified safely without changing production. Unknown live state remains explicitly unknown until it is inspected through an approved read-only source.

## Baseline status

| Field                                  | Status                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Baseline date                          | 2026-10-10                                                                      |
| Repository branch/HEAD at review start | `main` / `c2e09ea8`                                                             |
| Worktree                               | Phase plan and Phase 1 documentation/test-orchestration changes are in progress |
| Production data changes                | None                                                                            |
| Interactive signed-in browser          | Unavailable; protected-route runtime evidence remains open                      |
| Direct Render configuration inspection | Not available in this session                                                   |

## Last immutable production evidence in the repository

The latest checked-in deployment audit records application source `93476e51d7f5c61c5fe4ead51be68bbaa405fe7e` for Site, API, and outbox worker on 2026-09-23 UTC. It records passing health/readiness and a passing dedicated Partner Portal production journey. Current repository HEAD `c2e09ea8` adds the release audit document on top of that application source.

This is historical immutable evidence, not a claim that the same revisions, flags, providers, or health state are live on 2026-10-10. Current service revisions must still be captured read-only from Render before Phase 0 closes.

Source: `docs/audits/partner-confirmation-resource-capacity-2026-09-22.md`.

## Expected service topology

| Service        | Expected name             | Revision to verify  | Health/readiness to verify                                    |
| -------------- | ------------------------- | ------------------- | ------------------------------------------------------------- |
| Site           | `stonegate-site`          | Open                | `/api/healthz`, public Site, controlled Team/Mobile login     |
| API            | `stonegate-api`           | Open                | `/api/healthz`, readiness, migration target/current migration |
| Worker         | `stonegate-outbox-worker` | Open                | Heartbeat, queue health, no poison/retry surge                |
| Optional agent | `stonegate-discord-agent` | Open                | Expected enablement and approval-only behavior                |
| Database       | `stonegate-db`            | Not a code revision | Backup status, connection health, current migration           |

## Deployment-controlled capability inventory

The example configuration is fail-closed for the following high-impact capabilities. Effective production state is deliberately not inferred from source or recorded here until verified from deployment configuration.

| Area                 | Representative flags                                                                                                                                                                                 | Source/example default                        | Effective production state |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------- |
| Appointment media    | `APPOINTMENT_MEDIA_WRITES_ENABLED`, `PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED`, `MEDIA_AUTO_IMPORT_ENABLED`, `MOBILE_OFFLINE_MEDIA_ENABLED`                                                                | Disabled                                      | Unknown                    |
| Quote V2             | `QUOTE_V2_DUAL_WRITE_ENABLED`, `QUOTE_V2_STAFF_ENABLED`, `QUOTE_V2_SENDER_ENABLED`, `QUOTE_V2_PUBLIC_ENABLED`, `QUOTE_V2_MUTATIONS_ENABLED`, `QUOTE_V2_DEPOSITS_ENABLED`, `QUOTE_V2_BOOKING_ENABLED` | Operationally gated                           | Unknown                    |
| Mobile booking cards | `MOBILE_BOOKING_CARDS_V2_ENABLED`                                                                                                                                                                    | Code default is enabled unless explicitly `0` | Unknown                    |
| Mobile Square        | `MOBILE_SQUARE_PAYMENTS_ENABLED`                                                                                                                                                                     | Disabled                                      | Unknown                    |
| Expense receipts     | `EXPENSE_RECEIPT_CAPTURE_ENABLED`, `EXPENSE_RECEIPT_WORKER_ENABLED`, `EXPENSE_RECEIPT_CREW_ENABLED`                                                                                                  | Disabled                                      | Unknown                    |
| Expense modules      | `EXPENSE_AD_SPEND_ENABLED`, `EXPENSE_REIMBURSEMENT_ENABLED`, `EXPENSE_OVERVIEW_ENABLED`, `EXPENSE_DUMP_TICKETS_ENABLED`, `EXPENSE_FIXED_COSTS_ENABLED`                                               | Disabled                                      | Unknown                    |

Do not add secrets or credential values to this document. A dated release audit may record only enabled/disabled state, service ownership, and verification evidence.

## Data-protection baseline

- The live database must not be reset, reseeded, truncated, or used as an E2E target.
- Alignment work uses additive migrations and forward fixes.
- Schema rollout, code rollout, backfill, and retirement should be separated when operational risk warrants it.
- A restore exercise must use an isolated recovery target; do not overwrite the live database to prove a backup.
- Backfill and cleanup commands that support `--dry-run` or explicit `--execute` remain opt-in and must not be invoked during ordinary verification.

## Demo-data boundary

Before a prospect demo, create or identify controlled records that:

- Use a dedicated test phone number and email inbox.
- Cannot message or call real customers.
- Cannot charge or refund a real payment method.
- Are excluded from operational reporting where the product supports that distinction, or are clearly labeled and cleaned up through approved application workflows.
- Contain no real customer name, address, phone, email, media, message, or payment evidence.
- Exercise the same deployed product and permissions as normal users.

Actual demo identities and records remain open because creating them would change system state and requires explicit operational coordination.

## Rollback and recovery items to verify

- [ ] Record the current known-good Render revision for each service.
- [ ] Confirm who is authorized to initiate a Render rollback.
- [ ] Confirm database backup retention and the most recent successful backup.
- [ ] Perform or cite an isolated restore exercise without touching production.
- [ ] Record the current API migration and reviewed `DB_MIGRATION_TARGET`.
- [ ] Confirm worker rollback compatibility when Site/API versions differ temporarily.
- [ ] Confirm provider kill switches and external-send containment.
- [ ] Record the approved release window and operational contact for a rollback decision.

## Protected visual/runtime baselines still required

- [ ] Mobile at 320 px and 375 px: login, Today, Inbox, Contacts, Calendar/job detail, Quotes handoff, Spend, Owner, Access, and Settings.
- [ ] Desktop at agreed widths: Inbox, Contact, Quote V2, Calendar/job detail, Expenses, Owner, Partner staff workspace, and Access.
- [ ] Controlled end-to-end office-to-field prospect journey.
- [ ] Real-device confirmation on the phones used by daily operators.

## Phase 0 close condition

Phase 0 remains open until current deployed revisions, effective flags, backup/restore evidence, rollback ownership, release window, controlled demo identities, and protected signed-in visual/runtime baselines are recorded. Source documentation work may proceed in parallel, but it cannot replace these live-only gates.
