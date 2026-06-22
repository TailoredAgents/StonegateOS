# Commission Policy

Effective for new commission calculations going forward:

- Sales commission is retired. Keep seller attribution for reporting and job history, but do not generate new sales commission payouts.
- Management is 17.5% of the final amount paid.
- Jeffrey receives 11.25% and Austin receives 6.25%.
- Labor is always 20% of the final amount paid, regardless of who works the job.
- Most labor crews split the 20% labor pool evenly across selected crew members.
- When Jeffrey, Austin, and Devon work together, labor is split so Jeffrey receives 15% total, Austin receives 15% total, and Devon receives 7.5% total.
- Two-person labor crews receive 10% each.
- Labor override days and demo-specific 30% labor behavior are retired and ignored by new commission calculations.

Implementation notes:

- Current defaults live in `apps/api/src/lib/commissions.ts` and `apps/api/src/db/schema.ts`.
- Crew split resolution is mirrored in `apps/api/src/lib/locked-crew-payout.ts` and `apps/site/src/app/team/lib/locked-crew-payout.ts`.
- Migration `0056_commission_2026_06_rates.sql` sets the database defaults and the default settings row to sales 0%, management 17.5%, and labor 20%.
