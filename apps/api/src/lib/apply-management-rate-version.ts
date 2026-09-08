import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  appointmentCommissions,
  appointments,
  auditLogs,
  commissionManagementRateRecipients,
  commissionManagementRateVersions,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import { validateManagementRateVersion } from "@/lib/management-commission-rates";
import {
  lockCompletedAppointmentPayoutPeriodInTransaction,
  recalculateAppointmentCommissions,
  refreshDraftPayoutReports,
  validateCommissionRecipientMembers,
} from "@/lib/commissions";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
export type ManagementRateChange = {
  effectiveFrom: Date;
  actorId: string;
  reason: string;
  recipients: Array<{ memberId: string; rateBps: number }>;
};

/** Caller owns commit/rollback. Serializes with job completion and payout finalization. */
export async function applyManagementRateVersion(
  tx: Transaction,
  input: ManagementRateChange,
  now = new Date(),
) {
  const totalRateBps = input.recipients.reduce(
    (sum, row) => sum + row.rateBps,
    0,
  );
  validateManagementRateVersion(totalRateBps, input.recipients);
  if (
    !Number.isFinite(input.effectiveFrom.getTime()) ||
    !input.reason.trim() ||
    input.reason.length > 2000
  ) {
    throw new Error("invalid_management_rate_change");
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('commission_settings'), hashtext('default'))`,
  );
  const requiredIds = [
    ...new Set([input.actorId, ...input.recipients.map((row) => row.memberId)]),
  ];
  const members = await tx
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      active: teamMembers.active,
    })
    .from(teamMembers)
    .where(inArray(teamMembers.id, requiredIds))
    .for("share");
  validateCommissionRecipientMembers(requiredIds, members);

  const jobs = await tx
    .select({ id: appointments.id, completedAt: appointments.completedAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.completedAt, input.effectiveFrom),
        lte(appointments.completedAt, now),
      ),
    )
    .orderBy(appointments.completedAt, appointments.id);
  const payoutRunIds = new Set<string>();
  for (const job of jobs) {
    const period = await lockCompletedAppointmentPayoutPeriodInTransaction(
      tx,
      job.completedAt,
    );
    if (!period.ok)
      throw new Error("management_rate_change_intersects_finalized_payout");
    for (const id of period.payoutRunIds) payoutRunIds.add(id);
  }
  const ids = jobs.map((job) => job.id).sort();
  if (ids.length)
    await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(inArray(appointments.id, ids))
      .orderBy(appointments.id)
      .for("update");
  const before = ids.length
    ? await tx
        .select()
        .from(appointmentCommissions)
        .where(inArray(appointmentCommissions.appointmentId, ids))
    : [];

  const [existing] = await tx
    .select()
    .from(commissionManagementRateVersions)
    .where(
      and(
        eq(commissionManagementRateVersions.settingsKey, "default"),
        eq(commissionManagementRateVersions.effectiveFrom, input.effectiveFrom),
      ),
    )
    .limit(1);
  let versionId = existing?.id;
  const canonical = (rows: Array<{ memberId: string; rateBps: number }>) =>
    JSON.stringify(
      rows
        .map((row) => [row.memberId, row.rateBps])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  if (existing) {
    const saved = await tx
      .select()
      .from(commissionManagementRateRecipients)
      .where(eq(commissionManagementRateRecipients.versionId, existing.id));
    if (
      existing.totalRateBps !== totalRateBps ||
      canonical(saved) !== canonical(input.recipients)
    ) {
      throw new Error("management_rate_version_conflict");
    }
  } else {
    const [version] = await tx
      .insert(commissionManagementRateVersions)
      .values({
        settingsKey: "default",
        effectiveFrom: input.effectiveFrom,
        totalRateBps,
        reason: input.reason.trim(),
        createdBy: input.actorId,
      })
      .returning({ id: commissionManagementRateVersions.id });
    if (!version) throw new Error("management_rate_version_missing");
    versionId = version.id;
    await tx
      .insert(commissionManagementRateRecipients)
      .values(
        input.recipients.map((row) => ({ ...row, versionId: version.id })),
      );
  }

  for (const id of ids)
    await recalculateAppointmentCommissions(
      tx as unknown as DatabaseClient,
      id,
      { failClosedOnSchemaMismatch: true },
    );
  const after = ids.length
    ? await tx
        .select()
        .from(appointmentCommissions)
        .where(inArray(appointmentCommissions.appointmentId, ids))
    : [];
  const unaffected = (rows: typeof before) =>
    JSON.stringify(
      rows
        .filter((row) => row.role !== "marketing")
        .map((row) => [
          row.appointmentId,
          row.memberId,
          row.role,
          row.baseCents,
          row.amountCents,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  if (unaffected(before) !== unaffected(after))
    throw new Error("non_management_commission_would_change");
  await refreshDraftPayoutReports(tx as unknown as DatabaseClient, {
    payoutRunIds: [...payoutRunIds],
  });
  await tx.insert(auditLogs).values({
    actorType: "system",
    actorId: input.actorId,
    actorLabel: "Owner-authorized management rate change",
    action: "commission.management_rate_version.applied",
    entityType: "commission_management_rate_version",
    entityId: versionId,
    meta: {
      effectiveFrom: input.effectiveFrom.toISOString(),
      reason: input.reason,
      recipients: input.recipients,
      before,
      after,
      refreshedPayoutRunIds: [...payoutRunIds],
    },
  });
  return {
    versionId,
    effectiveFrom: input.effectiveFrom.toISOString(),
    jobsChecked: ids.length,
    members: input.recipients.map((recipient) => ({
      name: members.find((member) => member.id === recipient.memberId)?.name,
      ratePercent: recipient.rateBps / 100,
      beforeManagementCents: before
        .filter(
          (row) =>
            row.memberId === recipient.memberId && row.role === "marketing",
        )
        .reduce((sum, row) => sum + row.amountCents, 0),
      afterManagementCents: after
        .filter(
          (row) =>
            row.memberId === recipient.memberId && row.role === "marketing",
        )
        .reduce((sum, row) => sum + row.amountCents, 0),
    })),
  };
}
