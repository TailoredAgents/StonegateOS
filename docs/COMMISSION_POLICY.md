# Commission Policy

Effective for new commission calculations going forward:

- Sales commission is retired. Keep seller attribution for reporting and job history, but do not generate new sales commission payouts.
- Management is 15% of the final amount paid.
- Jeffrey and Austin split management evenly: Jeffrey receives 7.5% and Austin receives 7.5%.
- Labor is always 22.5% of the final amount paid, regardless of who works the job.
- All labor crews split the 22.5% labor pool evenly across selected crew members.
- When Jeffrey, Austin, and Devon work together, each receives 7.5% of the final amount paid.
- Two-person labor crews receive 11.25% each.
- Labor override days and demo-specific 30% labor behavior are retired and ignored by new commission calculations.

Implementation notes:

- Current defaults live in `apps/api/src/lib/commissions.ts` and `apps/api/src/db/schema.ts`.
- Crew split resolution is mirrored in `apps/api/src/lib/locked-crew-payout.ts` and `apps/site/src/app/team/lib/locked-crew-payout.ts`.
- Migration `0050_commission_2026_05_rates.sql` sets the database defaults and the default settings row to sales 0%, management 15%, and labor 22.5%.
