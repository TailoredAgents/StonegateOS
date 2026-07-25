# Release B payment migration audit

Run this report before and after migration `0059_square_payments`. It opens one
PostgreSQL transaction at `REPEATABLE READ, READ ONLY`, issues only `SELECT`
statements, prints JSON, and never calls Stripe or Square.

From a trusted shell with the target database configured:

```bash
pnpm payment-migration:audit
```

To change the number of IDs included in each review sample:

```bash
pnpm payment-migration:audit -- --sample-limit=50
```

The default sample limit is 25; valid values are 0 through 100. Counts always
cover the entire database even when samples are limited.

## Before 0059

Expect `"phase": "pre_0059"` and
`"schema.paymentLedgerAvailable": false`. Review:

- completed appointments with missing or negative final totals;
- matched and unmatched successful Stripe rows;
- predicted legacy-completion row, job, and tip totals;
- ambiguous historical card tips;
- appointments with multiple successful Stripe rows;
- Stripe job coverage above the agreed final total;
- non-positive successful Stripe amounts; and
- duplicate Stripe charge identifiers.

`predictedLegacyCompletionRows` mirrors the additive backfill in migration
0059. `manualReviewAppointments` is intentionally stricter: it also calls out
deterministic but unusual records that the release lead should inspect rather
than silently accept.

Run the migration dry-run separately:

```bash
pnpm db:migrate:payments:check
```

The migration dry-run verifies migration history and file selection. The
payment audit verifies historical business data. Both must be reviewed before
applying 0059.

## After 0059

Run the same command again. Expect `"phase": "post_0059"` and
`"schema.paymentLedgerAvailable": true`. In addition to the historical
prediction, the report includes:

- actual `legacy_completion` counts and amounts;
- predicted legacy rows that are missing;
- unexpected legacy rows;
- needs-review payments, attempts, refunds, and provider events;
- failed provider events; and
- duplicate provider/payment identifiers.

Do not enable `SQUARE_POS_ENABLED` while any unexplained
`predictedLegacyRowsMissing`, `unexpectedLegacyRows`, duplicate identifier, or
needs-review count remains. The report contains internal IDs only—no customer
names, addresses, phone numbers, or provider secrets.

## Safety notes

- Use a read-only database credential when one is available; the command also
  enforces a read-only transaction server-side.
- Save the pre- and post-migration JSON with the release record.
- Do not redirect reports into the repository if they contain production IDs.
- This command does not attach unmatched Stripe payments and does not repair
  any data. Owner reconciliation remains a separate, audited action.
