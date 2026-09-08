import { and, desc, eq, lte } from "drizzle-orm";
import {
  commissionManagementRateRecipients,
  commissionManagementRateVersions,
  teamMembers,
  type DatabaseClient,
} from "@/db";

export type ManagementRateRecipient = {
  memberId: string;
  rateBps: number;
  name: string | null;
  active: boolean;
};

export function validateManagementRateVersion(
  totalRateBps: number,
  recipients: readonly Pick<ManagementRateRecipient, "memberId" | "rateBps">[],
): void {
  if (
    !Number.isInteger(totalRateBps) ||
    totalRateBps < 0 ||
    totalRateBps > 10000 ||
    recipients.length === 0 ||
    new Set(recipients.map((entry) => entry.memberId)).size !==
      recipients.length ||
    recipients.some(
      (entry) =>
        !entry.memberId ||
        !Number.isInteger(entry.rateBps) ||
        entry.rateBps < 0 ||
        entry.rateBps > 10000,
    ) ||
    recipients.reduce((sum, entry) => sum + entry.rateBps, 0) !== totalRateBps
  )
    throw new Error("invalid_management_rate_version");
}

/** Resolve by the job's completion instant, never the date it is recalculated. */
export async function readManagementRateVersion(
  db: Pick<DatabaseClient, "select">,
  at: Date,
) {
  if (!Number.isFinite(at.getTime()))
    throw new Error("invalid_management_rate_date");
  const [version] = await db
    .select({
      id: commissionManagementRateVersions.id,
      effectiveFrom: commissionManagementRateVersions.effectiveFrom,
      totalRateBps: commissionManagementRateVersions.totalRateBps,
    })
    .from(commissionManagementRateVersions)
    .where(
      and(
        eq(commissionManagementRateVersions.settingsKey, "default"),
        lte(commissionManagementRateVersions.effectiveFrom, at),
      ),
    )
    .orderBy(desc(commissionManagementRateVersions.effectiveFrom))
    .limit(1);
  if (!version) return null;
  const recipients = await db
    .select({
      memberId: commissionManagementRateRecipients.memberId,
      rateBps: commissionManagementRateRecipients.rateBps,
      name: teamMembers.name,
      active: teamMembers.active,
    })
    .from(commissionManagementRateRecipients)
    .innerJoin(
      teamMembers,
      eq(teamMembers.id, commissionManagementRateRecipients.memberId),
    )
    .where(eq(commissionManagementRateRecipients.versionId, version.id))
    .orderBy(commissionManagementRateRecipients.memberId);
  validateManagementRateVersion(version.totalRateBps, recipients);
  return { ...version, recipients };
}
