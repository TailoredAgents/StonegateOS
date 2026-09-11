Dynamic crew labor applies to percentage-paid service jobs when their crew is saved or the job is newly completed. The pool is calculated from the final job total and divided equally among the selected active staff. Account roles do not determine pay eligibility: Austin, Jeffrey, Jed, and Devon can be selected without changing Devon's sales permissions.

| Selected staff     | Labor pool | Share per person | Each person's pay on a $1,000 job |
| ------------------ | ---------- | ---------------- | --------------------------------- |
| 1                  | 20%        | 20%              | $200                              |
| 2, any pair        | 20%        | 10%              | $100                              |
| 3, any combination | 30%        | 10%              | $100                              |
| 4                  | 30%        | 7.5%             | $75                               |

The pool stays at 30% for larger crews and is divided equally. Whole cents are distributed deterministically; rounding can leave a one-cent difference between people. An empty crew cannot complete a service job. Moving jobs retain hourly rate × time worked, with no percentage pool. Dated management commissions remain separate, so the total Labor expense can exceed the crew pool.

New crew selections ignore retired named splits, member default weights, and member guaranteed percentage settings. Clients cannot submit a pool rate or guaranteed rate. The server stores equal weights and a `pool_rate_bps` snapshot on every percentage crew assignment. Payroll settings report both pool tiers and the hourly exception.

Migration `0174_dynamic_crew_labor` adds the nullable crew snapshot and its validation constraint. Existing rows stay null; applying the migration does not rewrite completed jobs, commissions, payout lines, or expenses. Existing percentage work retains its saved weights, guarantees, and legacy 20% pool when recalculated. A total-only correction keeps that saved policy. Explicitly saving the crew applies the current policy; reopening and completing a job again also applies the current policy. Jobs already assigned to a locked or paid payout period require an adjustment instead of rewriting financial attribution.

Completion saves crew, commissions, refreshed draft payout reports, audit records, and the idempotency receipt in one transaction. Spend reads those commission amounts before payroll is locked, then reads the frozen payout amounts and pool details. Marking payroll paid posts one payroll expense; the overview excludes that bookkeeping expense from a second labor charge. Management, hourly work, and percentage crew remain separately attributable.

Release the matching database schema, API, site, and all commission-writing workers together. The Render blueprint's API pre-deploy step requires `DB_MIGRATION_TARGET=latest` and `SKIP_DB_MIGRATE` unset or `0` to apply this migration. Legacy migration targets stop too early. Coordinate release of the API and workers so an older process cannot recalculate newly snapshotted jobs using the retired 20% logic. After dynamic completions exist, rolling back to code that ignores the snapshot can produce incorrect earnings.

Verify release with a normal job selecting Jeffrey and Jed, add Devon to the crew, then select all four: the completion preview, Payroll report, and Spend details should agree on 20%/30%/30% and 10%/10%/7.5% per person. Verify moving hourly pay, an unchanged historical job, and one paid payroll record as well.

Regression coverage:

- `dynamic-crew-labor.test.ts`: crew counts, identity deduplication, equal cent allocation, retired overrides, historical allocation, and inconsistent snapshots.
- `dynamic-crew-labor.integration.test.ts`: PostgreSQL earnings, database constraints, pool details, Spend totals, locked payout snapshots, and exactly one posted payroll expense.
- `appointment-status-final-total.test.ts`: new and saved crews, roster corrections, total-only preservation, forged payout input, locked/paid periods, replay, and rollback; moving-hourly behavior remains covered.
- `dynamic-labor-settings.test.ts`: both policy tiers, retired configuration independence, payout-schedule saves, management policy preservation, and permissions.
- Expense repository and mobile Spend tests cover percentage crew detail grouping and frozen snapshots; completion surface tests cover crew selection on desktop and mobile.
