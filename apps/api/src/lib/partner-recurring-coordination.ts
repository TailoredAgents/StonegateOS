import { sql } from "drizzle-orm";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export const PARTNER_RECURRING_HORIZON_CLAIM_LOCK =
  "partner_recurring_horizon_claim_v1";

/**
 * Serializes horizon claims with recurring-series lifecycle changes. A
 * lifecycle transaction takes this lock before inspecting occurrences, so a
 * tentative row cannot become evaluating between the inspection and CAS.
 */
export async function acquirePartnerRecurringHorizonClaimLock(
  tx: TeamMutationTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${PARTNER_RECURRING_HORIZON_CLAIM_LOCK}))`,
  );
}
