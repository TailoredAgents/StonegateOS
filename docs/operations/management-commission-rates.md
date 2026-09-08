# Effective-dated management commissions

Management policies are selected using the job's completion timestamp (scheduled start is the legacy fallback). They do not change crew or sales commissions. Before the first dated policy, the existing 17% pool and configured 12:5 management split remain applicable.

The owner-approved policy effective **September 7, 2026, 00:00 America/New_York** is Austin 0% and Jeffrey 5%. Activation is a separate database operation after the API deployment; the schema migration does not activate this business policy.

## Apply a policy

1. Deploy migration `0163_effective_management_commission_rates` and the matching API code. Verify every commission-writing deployment uses the new code before activation.
2. Use a securely supplied `DATABASE_URL`; never put credentials in commands, files, reports, or Git.
3. From `apps/api`, run `pnpm exec tsx scripts/apply-management-rates.ts` with `--effective-from` (an explicit RFC 3339 instant), `--actor` (the authorizing staff UUID), `--reason`, and one `--recipient UUID:BASIS_POINTS` per recipient. For example, 500 basis points means 5%; include a zero-rate recipient when removing their management commission.
4. Without `--execute`, the operation calculates the result inside a transaction and rolls everything back. Inspect the before/after totals.
5. Repeat the identical command with `--execute` to commit. Verify current management totals, unchanged crew/sales totals, historical rows, and draft payout reports.

The command serializes with commission recalculation, checks active recipient identities, refuses any affected locked/paid payout period, and aborts if any non-management commission amount would change. It writes an audit event containing before/after commission records and refreshes affected draft reports atomically. Repeating an identical policy is safe; a different policy at the same effective instant is rejected.

Versions and recipient records are append-only. Correct future rates by adding a new effective version. Do not roll application code back to a version that ignores dated policies after activation.

## Verification

- `management-commission-rates.test.ts`: rates, zero recipients, duplicate members, invalid totals.
- `management-commission-rates.integration.test.ts`: real PostgreSQL cutoff boundary, unchanged historical records, historical recalculation, future jobs, replay, immutable history, unchanged crew money, finalized-payout rejection.
- `completed-job-financial-reconciliation.integration.test.ts`: Spend and payout reporting agree on completed legacy service work.
- Expense live-refresh tests: automatic refresh, reconnect/resume, stale-data warnings, request coalescing, and access expiry.
