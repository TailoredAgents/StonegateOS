# Commission Policy

Effective for new commission calculations going forward:

- Sales commission is retired. Keep seller attribution for reporting and job history, but do not generate new sales commission payouts.
- Management follows the dated policy in effect at completion. The historical baseline is 17% split Jeffrey 12% / Austin 5%; the approved September 7, 2026 policy is Jeffrey 5% / Austin 0% once activated. See [management policy activation](operations/management-commission-rates.md).
- Percentage crew labor uses 20% of the final job total for one or two people and 30% for three or more, split equally among everyone selected.
- A solo worker receives 20%; any pair receives 10% each; three people receive 10% each; all four receive 7.5% each.
- Austin, Jeffrey, Jed, and Devon are selectable as active staff, independently of account role.
- Moving jobs use each worker's hourly rate and actual time instead of percentage labor.
- Named unequal splits, guaranteed member percentages, and labor override days do not affect new crew assignments. Saved historical percentage compensation remains unchanged on ordinary recalculation.

Implementation notes:

- The shared crew-count policy lives in `packages/pricing/src/crew-labor.ts`. The server resolves crew pay and ignores client weights.
- Migration `0174_dynamic_crew_labor.sql` stores the selected pool on appointment crew rows. Null snapshots preserve historical weights and guaranteed percentages; explicit roster corrections use the current policy.
- Completion updates earned commissions and draft payroll reports atomically. Spend consumes those earnings, then frozen payout snapshots after payroll is locked, without counting the posted payroll expense twice.
- See [dynamic labor operations](operations/dynamic-crew-labor.md) for release requirements, historical corrections, cent rounding, and regression coverage.
