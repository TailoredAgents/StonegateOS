# Professional Quotes V2 performance release harness

## Purpose

This runbook operates the bounded Quote V2 release-performance harness. It
measures the canonical staff list/search query, the canonical public proposal
envelope, and the standard React-PDF proposal without calling delivery,
payment, scheduling, object-storage, or AI providers.

The release thresholds are:

| Metric                           | Fixture                                                                     | Gate                                                   |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Quote list, first page           | 10,000 contacts and Quote V2 aggregates                                     | p95 under 500 ms; at most one SQL statement per sample |
| Quote list, cursor page          | Same 10,000-row fixture and a real opaque cursor                            | p95 under 500 ms; at most one SQL statement per sample |
| Contact/project quote search     | Rotating contact, company, project, PO, property, and quote-number searches | p95 under 300 ms; at most one SQL statement per sample |
| Canonical public proposal render | Deterministic standard commercial proposal                                  | p95 under 100 ms                                       |
| Standard proposal PDF            | The same proposal rendered by the production React-PDF renderer             | p95 under 3 seconds                                    |

The 100 ms public-render threshold is a server CPU regression gate. It is not
a substitute for the product requirement of mobile LCP under 2.5 seconds.

## Safety and prerequisites

The database lane is intentionally opt-in and fails closed unless all of the
following are true:

1. `DATABASE_URL` identifies a disposable, fully migrated PostgreSQL database.
2. The database contains zero contacts and zero quotes before the run.
3. `NODE_ENV` is not `production`.
4. The operator supplies both `--execute` and the exact confirmation phrase.

The harness creates exactly 10,000 synthetic contacts, properties,
opportunities, quotes, and quote versions inside one database transaction. It
updates planner statistics, performs the measurements, and deliberately throws
a private rollback signal. No benchmark rows are committed. An error at any
point also rolls the transaction back.

Never point the harness at production, a shared staging database, or a database
whose contents must be retained. The empty-database check is a reproducibility
control, not permission to use a valuable database.

Before a release run, provision a new database through the normal development
or release infrastructure, set its `DATABASE_URL`, and apply all migrations:

```bash
DATABASE_URL='postgresql://USER:PASSWORD@HOST/DISPOSABLE_DB' \
  corepack pnpm db:migrate
```

Do not place database credentials in shell history, tickets, committed files,
or benchmark artifacts. Prefer the environment/secrets mechanism for the
target environment.

## Fast render-only verification

Render mode needs no database and is safe for a developer workstation:

```bash
corepack pnpm --filter api exec tsx scripts/quote-v2-performance.ts \
  --mode=render
```

It runs 20 warmups plus 200 canonical public renders, and two warmups plus 20
standard PDF renders. The PDF work runs in an isolated Jest ESM worker so it
loads the same React-PDF module graph used by the product and its automated
document tests. Worker startup time is excluded from the measured PDF samples.

For the smallest accepted local render sample:

```bash
corepack pnpm --filter api exec tsx scripts/quote-v2-performance.ts \
  --mode=render \
  --public-samples=50 \
  --pdf-samples=20
```

## Full 10,000-row release run

From the repository root, with a disposable migrated database:

```bash
DATABASE_URL='postgresql://USER:PASSWORD@HOST/DISPOSABLE_DB' \
NODE_ENV=test \
corepack pnpm --filter api exec tsx scripts/quote-v2-performance.ts \
  --mode=release \
  --execute \
  --confirm=QUOTE_V2_PERFORMANCE_10000_ROLLBACK
```

Defaults and accepted ranges are deliberately bounded:

| Argument             |                        Default |                                   Accepted range |
| -------------------- | -----------------------------: | -----------------------------------------------: |
| `--database-samples` |                             30 |                                           20–100 |
| `--public-samples`   |                            200 |                                         50–2,000 |
| `--pdf-samples`      |                             20 |                                            20–50 |
| `--seed`             | `stonegate-qv2-performance-v1` | 1–64 lowercase letters, digits, `.`, `_`, or `-` |

Use the default seed for comparable release evidence. The report contains only
its SHA-256 digest.

## Reading the report

The command prints one JSON report and exits nonzero when any gate fails. Each
latency metric includes sample/warmup counts, p50, nearest-rank p95, maximum,
threshold, and pass/fail. Database metrics additionally include the largest
observed statements-per-sample count and the allowed maximum of one.

A valid full report must show:

- `ok: true` and `mode: "release"`;
- `rowCount: 10000`;
- five passing metrics;
- five seeded table counts of exactly 10,000;
- `transactionRolledBack: true`;
- one SQL statement or fewer for every measured list/search sample.

The first page and cursor page must each return 50 rows. Each rotating search
must return exactly one matching quote. A shape mismatch fails the run even if
the measured latency is below threshold.

Archive the JSON as release evidence together with the commit SHA, database
engine/version, runner class, and date. The report already records Node,
platform, architecture, and timestamps. Do not edit a failing result into a
passing one.

## Verified release evidence — 2026-08-31

The default full release command above passed on the current worktree against
a new, fully migrated PostgreSQL 16.14 disposable database. The runner used
Node 20.20.2 on Darwin arm64. All five synthetic tables were seeded with
exactly 10,000 rows.

| Metric                           | Observed p95 | Required p95 | Maximum queries/sample | Result |
| -------------------------------- | -----------: | -----------: | ---------------------: | ------ |
| Quote list, first page           |    14.151 ms |     < 500 ms |                      1 | Pass   |
| Quote list, cursor page          |    13.423 ms |     < 500 ms |                      1 | Pass   |
| Contact/project quote search     |    41.608 ms |     < 300 ms |                      1 | Pass   |
| Canonical public proposal render |     1.044 ms |     < 100 ms |                    N/A | Pass   |
| Standard proposal PDF            |    87.548 ms |   < 3,000 ms |                    N/A | Pass   |

The report returned `ok: true`, `mode: "release"`, and
`transactionRolledBack: true`. A separate post-run count verified zero
contacts, properties, opportunities, quotes, and quote versions, so the
rollback boundary left no benchmark fixture behind. These measurements close
the local 10,000-row database/query-fan-out and standard-render gates; the
browser and production-like concurrency limitations below still apply.

The table above records the designated release run. A same-worktree
confirmation run also passed all five gates; its complete, unedited native
runner output is archived as [Professional Quotes V2 native performance
report](../evidence/professional-quotes-v2-performance-2026-08-31.json). The
separate [sanitized provenance
manifest](../evidence/professional-quotes-v2-performance-2026-08-31.manifest.json)
records the runner, database version, exact invocation, source revision and
worktree marker, independent rollback check, and local-only/awaiting-CI status.
Neither artifact contains a database URL, credentials, or customer data.

## Expected prerequisite failures

These failures are intentional and actionable:

| Code                                             | Resolution                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `performance_database_url_required`              | Supply `DATABASE_URL` only for a disposable migrated database.                       |
| `performance_execute_required`                   | Add `--execute` after reviewing this runbook.                                        |
| `performance_confirmation_required`              | Supply the exact confirmation phrase.                                                |
| `performance_production_database_forbidden`      | Stop; select a non-production benchmark database.                                    |
| `performance_quote_v2_migrations_required`       | Apply the complete migration set.                                                    |
| `performance_disposable_empty_database_required` | Select a new empty database rather than deleting shared data.                        |
| `performance_seed_count_mismatch`                | Treat this as a schema/constraint regression and investigate.                        |
| `performance_pdf_worker_failed`                  | Run the focused PDF and harness tests, then inspect the Jest worker failure locally. |

Missing prerequisites never downgrade to a skipped or passing database gate.

## Focused code validation

```bash
corepack pnpm --filter api test -- --runInBand \
  src/__tests__/quote-v2-performance-harness.test.ts

corepack pnpm --filter api typecheck
```

The ordinary test suite does not discover the opt-in PDF benchmark worker. The
top-level performance command invokes it with bounded configuration and a
private temporary result file.

## Measurements outside this harness

This harness cannot establish the following release gates:

- mobile LCP, INP, and CLS under real browser/network conditions;
- 320 px layout, zoom, theme, reduced-motion, or accessibility behavior;
- BFF/authentication/HTTP serialization and network latency;
- object-storage upload/download latency or remote-logo retrieval;
- production connection-pool contention, replicas, cache state, or concurrent
  staff traffic.

Measure those separately with the blocking browser matrix and a production-like
canary environment. Do not infer Web Vitals or real concurrency capacity from
the Node/database p95 values in this report.
