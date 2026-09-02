import { and, eq, sql } from "drizzle-orm";
import { partnerAccountSchedulingPolicies, partnerAccounts } from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  validatePartnerAccountSchedulingPolicy,
  type PartnerAccountSchedulingPolicyValues,
} from "@/lib/partner-account-scheduling-policy";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type PolicyRow = typeof partnerAccountSchedulingPolicies.$inferSelect;

function snapshot(row: PolicyRow): Record<string, unknown> {
  return {
    partnerAccountId: row.partnerAccountId,
    minimumNoticeMinutes: row.minimumNoticeMinutes,
    minimumCalendarLeadDays: row.minimumCalendarLeadDays,
    maximumBookingHorizonDays: row.maximumBookingHorizonDays,
    instantConfirmationEnabled: row.instantConfirmationEnabled,
    revision: row.revision,
    lastChangedByTeamMemberId: row.lastChangedByTeamMemberId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updatePartnerAccountSchedulingPolicyAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    values: PartnerAccountSchedulingPolicyValues;
    expectedVersion: string;
    changedByTeamMemberId: string;
    now?: Date;
  },
): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  policy: PolicyRow;
}> {
  const values = validatePartnerAccountSchedulingPolicy(input.values);
  await acquireScheduleConflictLock(tx);

  const [account] = await tx
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      { status: 404 },
    );
  }

  const [current] = await tx
    .select()
    .from(partnerAccountSchedulingPolicies)
    .where(
      eq(
        partnerAccountSchedulingPolicies.partnerAccountId,
        input.partnerAccountId,
      ),
    )
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "conflict",
      "This account is missing its scheduling-policy record. Keep instant confirmation disabled and run the current migration before retrying.",
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.revision,
  );

  const now = input.now ?? new Date();
  const [updated] = await tx
    .update(partnerAccountSchedulingPolicies)
    .set({
      ...values,
      revision: sql`${partnerAccountSchedulingPolicies.revision} + 1`,
      lastChangedByTeamMemberId: input.changedByTeamMemberId,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          partnerAccountSchedulingPolicies.partnerAccountId,
          input.partnerAccountId,
        ),
        eq(partnerAccountSchedulingPolicies.revision, current.revision),
      ),
    )
    .returning();
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The scheduling policy changed while it was being saved. Refresh and try again.",
      { retryable: true },
    );
  }

  return {
    before: snapshot(current),
    after: snapshot(updated),
    policy: updated,
  };
}
