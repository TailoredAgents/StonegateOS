# Moving jobs

Choose **Moving Job** in the existing job-type selector. Book the customer,
starting property, time, duration, and quoted price as usual. Add a destination
address when the move ends at another property. The destination also appears
in job details and synchronized calendar notes.

When completing the job, select who worked and enter each person's hourly rate
and hours worked. The form previews each person's labor pay and the crew total.
Decimal hours are rounded to the nearest minute; pay is rounded once per worker
to the nearest cent. For example, $27.50/hour for 2.25 hours pays $61.88.

Moving crew pay replaces the percentage labor pool for that job. Existing
management, sales, and tip policies continue to apply. Other job types retain
their existing percentage pay. Customer pricing remains separate from crew pay.

Completion updates the existing payout ledger and draft payout reports. Saved
rates and hours prefill corrections. Finalized payout periods retain their
existing edit protection, and locked payouts preserve the labor breakdown.

Calendar and MyDay show **Correct crew pay** for completed Moving Jobs to staff
with appointment-update, payment-collection, and commission-management access.
**Save crew correction** updates the selected workers, rates, and hours while
keeping the final customer total read-only. Mobile offers **Correct completed
job**; changing its customer total additionally requires payment-management
access. Corrections do not offer another review request.

Invalid crew entries stay on the form with an explanation. Mobile and Calendar
show a saving state while submitting. **Convert only** remains available without
crew hours; **Convert + complete** requires valid hourly pay for the chosen crew.

Spend shows the applicable labor rows by job type and pay method, with summed
crew hours and distinct job counts. Hours represent worker time: two people
working three hours contribute six crew hours. Payroll expenses and
reimbursements retain their existing exclusions so labor is counted once.
Historical payouts without detailed records retain their original totals.

## Release

Apply migration `0173_moving_hourly_labor` before running the updated API and
site. The existing `pnpm db:migrate:release-latest` command includes it. On
Render, use the existing `DB_MIGRATION_TARGET=latest` deployment setting.

## Repeatable checks

Run the focused parser and browser checks from the repository root:

```sh
corepack pnpm exec tsx --test apps/site/test/crew-payout-form.test.ts scripts/test-moving-job-components.mts scripts/test-moving-completion-surfaces.mts
corepack pnpm --filter api exec jest --runInBand --testPathPattern='moving-booking|moving-hourly-labor|appointment-status-idempotency-contract|commission-recipient-integrity|calendar-experience-contract|calendar-payment-schema-fallback'
corepack pnpm --filter site typecheck
corepack pnpm --filter api typecheck
```

The layout checks cover 1024px, 375px, and 320px, including overflow and automated
accessibility checks. The surface harness renders the actual Calendar detail and
actions, MyDay completion card, and mobile completion/conversion forms. It checks
invalid submissions, saving states, failed retries and stable retry keys,
unconfirmed success responses, saved corrections after reload, permissions, and
switching job type with the MyDay booking editor enabled or disabled.

These browser harnesses substitute server actions and HTTP responses. They test
the real UI and submitted form data, not authenticated API/database integration.
The PostgreSQL workflow test runs only when `DATABASE_URL` is set; use a
disposable database with the current migrations applied. It verifies commission
recalculation, payout locking/payment, and expense reconciliation separately.

The committed-loader expense test additionally requires
`EXPENSE_OVERVIEW_LOADER_TESTS=1` and Node's `--experimental-vm-modules` option.
It clones a migrated, disposable PostgreSQL template and removes its test
database afterward. The conversion and hourly-workflow tests run in ordinary
Jest mode and roll back their fixtures.

## Validation audit

The authenticated Site and API were exercised against a freshly migrated,
disposable PostgreSQL database. A Moving Job was booked from the contact form,
shown on the calendar, and completed on mobile with two movers at different
rates. The payout was created, corrected through the saved job, locked,
exported as HTML and CSV, and marked paid.

| Check                        | Verified result                                 |
| ---------------------------- | ----------------------------------------------- |
| Initial crew pay             | $25 × 2.5 hours + $30 × 3 hours = $152.50       |
| Corrected crew pay           | $25 × 3.25 hours + $30 × 3 hours = $171.25      |
| Existing management pay      | $110.50 on the $650 job                         |
| Final payout and Spend labor | Both $281.75; 6.25 crew hours on one moving job |
| Payment retries              | No duplicate transition or expense              |
| Posted payroll               | Exactly one $281.75 expense; labor counted once |
| Correction after payment     | Rejected; original hours and payout preserved   |
| Cross-origin submission      | Rejected before financial changes               |

The audit fixed hourly-only payment authorization, payout locking for unchanged
wages already earned by retired movers, missing crew-correction controls, and
Next.js public-origin normalization blocking payout forms and redirects.
The shared origin resolver only trusts configured Site URLs matching HTTP Host.
It does not trust forwarding headers to establish a destination.

All 195 assertions across the 13 changed API test files passed, along with the
additional expense, database, browser, typecheck, and targeted lint checks.
Browser and database evidence is saved locally in `artifacts/moving-jobs/audit`.
External message delivery and provider calendar synchronization were disabled
in the disposable full-application test; calendar payloads were checked
separately in automated tests.

The repository-wide API suite is not fully green. A separate, unchanged HEAD
checkout reproduced the unrelated failures, including contact-merge contracts,
partner route manifests, and Jest module-loading incompatibilities. These do
not appear in the passing moving-workflow checks. The comparison is recorded
in `artifacts/moving-jobs/audit/api-baseline-comparison.json`.
