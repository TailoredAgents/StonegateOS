import { and, eq, isNotNull, sql } from "drizzle-orm";
import { outboxEvents, partnerBookings, partnerJobEvents } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

/** Explicit partner mapping only. Ordinary CRM jobs gain no proof or authentication requirement. */
export async function queuePartnerAppointmentStatusEffects(
  tx: TeamMutationTransaction,
  input: {
    appointmentId: string;
    status: string;
    previousStatus: string;
    version: string;
    actorTeamMemberId?: string | null;
  },
): Promise<void> {
  if (input.status === input.previousStatus) return;
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      accountId: partnerBookings.partnerAccountId,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.appointmentId, input.appointmentId),
        isNotNull(partnerBookings.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!job?.accountId) return;
  const labels: Record<string, string> = {
    completed: "Service completed",
    confirmed: "Service confirmed",
    canceled: "Service canceled",
  };
  if (!labels[input.status]) return;
  await tx
    .update(partnerBookings)
    .set({
      publicStatus: input.status,
      version: sql`${partnerBookings.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerBookings.id, job.id));
  await tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: job.accountId,
      partnerBookingId: job.id,
      eventType: `job.${input.status}`,
      publicLabel: labels[input.status]!,
      actorType: input.actorTeamMemberId ? "staff" : "system",
      actorTeamMemberId: input.actorTeamMemberId ?? null,
      effectiveAt: new Date(),
    });
  await tx
    .insert(outboxEvents)
    .values({
      type: "partner.job.status_committed",
      payload: {
        accountId: job.accountId,
        jobId: job.id,
        status: input.status,
        version: input.version,
      },
    });
  if (input.status === "completed")
    await tx
      .insert(outboxEvents)
      .values({
        type: "partner.proof.prepare",
        payload: { accountId: job.accountId, jobId: job.id },
      });
}
