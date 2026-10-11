# System Alignment Phase 1 Audit — 2026-10-10

> Local, source-based release-readiness evidence for the Phase 1 documentation and test-orchestration work. This is not a production certification.

## Audit identity

| Field                      | Value                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| Repository baseline        | `main` at `c2e09ea8`, plus the Phase 1 worktree                                  |
| Runtime used               | Windows Node `v22.19.0` and clean Linux container Node `v20.19.1`, pnpm `9.15.9` |
| Repository requirement     | Node `20.x`; verified on Node `v20.19.1`                                         |
| Production data changed    | No                                                                               |
| Database commands run      | None                                                                             |
| Provider actions triggered | None                                                                             |
| Signed-in browser evidence | Not available; no browser session was connected                                  |

## Outcome

Phase 1 has materially improved local documentation truth and release visibility:

- A canonical current-system overview, capability matrix, production baseline, operational risk register, and phased alignment plan now exist.
- Source-derived API route, database-column, and literal outbox-event indexes can be regenerated and checked for drift.
- Root and application READMEs, deployment guidance, critical-flow documentation, and the release checklist now describe the supported surfaces and safety boundaries more accurately.
- Superseded plans are labeled as historical or target-state documents rather than current certification.
- The API Jest lane now partitions legacy CommonJS-compatible tests from native ESM tests, preserving the complete inventory without missing `jest`, `__dirname`, or ESM-runtime globals.
- Windows can run the lint ratchet and the scripts that set environment variables.
- The general E2E workflow now collects later build and browser evidence even when API unit tests fail, then still fails the job; it also includes the complete Team audit and documentation drift check.
- Contact merge now blocks unsafe Partner portal-anchor merges and explicitly moves Quote V2 opportunities with revision evidence.
- An additive permission-baseline migration was authored for existing built-in Owner and read-only roles; it was not executed against any database.

The Phase 1 repository gate is complete: the documented local checks are green on the required Node 20 runtime. Production certification remains open because current deployed revisions, effective feature flags, backup/restore evidence, authenticated runtime baselines, protected Mobile baselines, and remote CI evidence have not yet been established.

## Verification ledger

| Check                                   | Result  | Notes                                                                                                                                                |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm docs:check`                       | Pass    | Generated indexes match source fingerprints.                                                                                                         |
| `pnpm typecheck`                        | Pass    | API and Site passed. Contentlayer generated all 23 documents after normalizing MDX line endings.                                                     |
| `pnpm typecheck:e2e:team-audit`         | Pass    | Team audit TypeScript contracts compile.                                                                                                             |
| `pnpm lint` / `pnpm lint:ratchet`       | Pass    | Zero errors; nine non-blocking React/Next warnings remain localized to desktop Partner components.                                                   |
| `pnpm build`                            | Pass    | All six Turbo build tasks passed locally. This is diagnostic evidence only because the local Node major does not match the required Node 20 runtime. |
| Representative API Jest set             | Pass    | 3 suites and 35 tests passed across appointment totals, Partner account profile, and Quote V2 acceptance certificates.                               |
| Full API Jest inventory                 | Pass    | 469 suites passed and 67 were skipped; 4,739 tests passed and 330 were skipped. Both legacy and native ESM partitions completed with zero failures.  |
| Clean Node 20 API Jest inventory        | Pass    | The same 469 suites and 4,739 tests passed in a clean `node:20-alpine` container on Node `v20.19.1`; no live services were contacted.                |
| Partner Portal API suite                | Pass    | 131 suites passed and 18 were skipped; 1,054 tests passed and 96 were skipped, with zero failures.                                                   |
| Partner Portal Site suite               | Pass    | 234 tests passed with no failures or skips.                                                                                                          |
| Authenticated Team/Mobile browser audit | Not run | The in-app browser had no connected browser instance. No substitute production or provider action was attempted.                                     |

## Generated source indexes

The following files are generated by `pnpm docs:generate` and enforced by `pnpm docs:check`:

- `docs/system/API_ROUTE_INDEX_API.md`: 486 API route handlers.
- `docs/system/API_ROUTE_INDEX_SITE.md`: 126 Site route handlers.
- `docs/system/DATA_DICTIONARY_COLUMNS.md`: 228 Drizzle table definitions.
- `docs/system/OUTBOX_EVENT_INDEX.md`: 80 literal outbox event types.

These counts are source inventory, not proof that every route or event is enabled, permission-correct, or healthy in production.

## Safety observations

- No schema migration, seed, reset, backfill, cleanup, or live database command was run.
- No mobile navigation or field workflow was redesigned.
- No production feature flag or deployment configuration was changed.
- No customer message, call, payment, refund, AI request, or provider operation was triggered.
- CI orchestration remains fail-closed: a future API failure will not prevent later evidence collection, but the workflow will still exit unsuccessfully.
- The new permission migration is additive and remains unapplied; it requires the normal migration review, backup, rollout, and post-deploy evidence before any production execution.

## Open release blockers

1. Capture current Site, API, and worker revisions and effective high-impact flags from Render using read-only evidence.
2. Verify backup retention, an isolated restore procedure, rollback ownership, migration target, and approved release window.
3. Confirm the green Node 20 matrix in remote CI and retain its evidence with the candidate revision.
4. Run the complete Team audit and protected Mobile journeys in an isolated E2E environment.
5. Capture Jeffrey-approved Mobile baselines and the desktop prospect journey before behavioral or visual parity work.
6. Create or approve sanitized demo identities that cannot reach real customers or collect real funds.
7. Review the additive permission-baseline migration in an isolated environment before considering a separately approved production rollout.

## Recommendation

Accept the Phase 1 repository gate as complete, not as authorization to deploy. Proceed with read-only and low-risk Phase 2 desktop foundation work while closing Phase 0 live-evidence items in parallel. Do not release production-affecting parity changes until the relevant revisions, flags, recovery evidence, protected Mobile baselines, sanitized demo boundary, and remote CI evidence are approved.
