import { and, eq, sql } from "drizzle-orm";
import { partnerAccountCancellationPolicies, partnerAccounts } from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { validatePartnerAccountCancellationPolicy } from "@/lib/partner-portal-v2-cancellation";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type PolicyRow = typeof partnerAccountCancellationPolicies.$inferSelect;

function snapshot(row: PolicyRow): Record<string, unknown> {
  return {
    partnerAccountId: row.partnerAccountId,
    minimumNoticeMinutes: row.minimumNoticeMinutes,
    directCancellationEnabled: row.directCancellationEnabled,
    lateCancellationDisposition: row.lateCancellationDisposition,
    automaticFeeMinor: row.automaticFeeMinor,
    revision: row.revision,
    lastChangedByTeamMemberId: row.lastChangedByTeamMemberId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updatePartnerAccountCancellationPolicyAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    minimumNoticeMinutes: number;
    directCancellationEnabled: boolean;
    expectedVersion: string;
    changedByTeamMemberId: string;
    now?: Date;
  },
): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  policy: PolicyRow;
}> {
  const values = validatePartnerAccountCancellationPolicy({
    minimumNoticeMinutes: input.minimumNoticeMinutes,
    directCancellationEnabled: input.directCancellationEnabled,
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
  });
  // Policy changes serialize with holds, submissions, reschedules, and
  // cancellations so no operation can evaluate a half-old policy decision.
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
    .from(partnerAccountCancellationPolicies)
    .where(
      eq(
        partnerAccountCancellationPolicies.partnerAccountId,
        input.partnerAccountId,
      ),
    )
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "conflict",
      "This account is missing its cancellation-policy record. Keep confirmed-job cancellations in staff review and run the current migration before retrying.",
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.revision,
  );

  const now = input.now ?? new Date();
  const [updated] = await tx
    .update(partnerAccountCancellationPolicies)
    .set({
      minimumNoticeMinutes: values.minimumNoticeMinutes,
      directCancellationEnabled: values.directCancellationEnabled,
      revision: sql`${partnerAccountCancellationPolicies.revision} + 1`,
      lastChangedByTeamMemberId: input.changedByTeamMemberId,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          partnerAccountCancellationPolicies.partnerAccountId,
          input.partnerAccountId,
        ),
        eq(partnerAccountCancellationPolicies.revision, current.revision),
      ),
    )
    .returning();
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The cancellation policy changed while it was being saved. Refresh and try again.",
      { retryable: true },
    );
  }

  return {
    before: snapshot(current),
    after: snapshot(updated),
    policy: updated,
  };
}
