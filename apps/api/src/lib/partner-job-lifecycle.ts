import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  appointments,
  outboxEvents,
  partnerBookings,
  partnerBookingVisits,
  partnerJobEvents,
} from "@/db";
import { queuePartnerJobAudienceNotification } from "./partner-notification-delivery";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

/** Resolve committed notifications against the commercial parent or the exact visit. */
export async function queuePartnerCommittedStatusNotification(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    jobId: string;
    status: "confirmed" | "rescheduled" | "completed" | "canceled";
    visitId?: string;
    version?: string;
    eventId: string;
  },
) {
  const [job] = await tx
    .select({
      modelVersion: partnerBookings.modelVersion,
      publicStatus: partnerBookings.publicStatus,
      appointmentStatus: appointments.status,
      serviceAt: partnerBookings.arrivalWindowStartAt,
      timezone: appointments.schedulingTimezone,
    })
    .from(partnerBookings)
    .leftJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(
      and(
        eq(partnerBookings.id, input.jobId),
        eq(partnerBookings.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!job) return;
  let serviceAt = job.serviceAt,
    timezone = job.timezone;
  if (
    job.modelVersion === 2 &&
    (input.status === "confirmed" || input.status === "rescheduled")
  ) {
    if (!input.visitId) return;
    const [visit] = await tx
      .select({
        status: partnerBookingVisits.status,
        version: partnerBookingVisits.version,
        serviceAt: appointments.promisedArrivalStartAt,
        timezone: appointments.schedulingTimezone,
      })
      .from(partnerBookingVisits)
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookingVisits.appointmentId),
      )
      .where(
        and(
          eq(partnerBookingVisits.id, input.visitId),
          eq(partnerBookingVisits.partnerBookingId, input.jobId),
          eq(partnerBookingVisits.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (
      !visit ||
      visit.status !== "scheduled" ||
      String(visit.version) !== input.version
    )
      return;
    serviceAt = visit.serviceAt;
    timezone = visit.timezone;
  } else if (
    (job.modelVersion === 2 ? job.publicStatus : job.appointmentStatus) !==
    input.status
  )
    return;
  await queuePartnerJobAudienceNotification({
    tx,
    accountId: input.accountId,
    partnerBookingId: input.jobId,
    eventType:
      input.status === "confirmed"
        ? "booking.created"
        : input.status === "rescheduled"
          ? "booking.rescheduled"
          : input.status === "completed"
            ? "booking.completed"
            : "booking.canceled",
    dedupeKey: input.eventId,
    occurredAt: new Date(),
    correlationId: null,
    accountTimezone: timezone,
    serviceAt,
    visitNotification: job.modelVersion === 2 && Boolean(input.visitId),
  });
}

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
  await tx.insert(partnerJobEvents).values({
    partnerAccountId: job.accountId,
    partnerBookingId: job.id,
    eventType: `job.${input.status}`,
    publicLabel: labels[input.status]!,
    actorType: input.actorTeamMemberId ? "staff" : "system",
    actorTeamMemberId: input.actorTeamMemberId ?? null,
    effectiveAt: new Date(),
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job.status_committed",
    payload: {
      accountId: job.accountId,
      jobId: job.id,
      status: input.status,
      version: input.version,
    },
  });
  if (input.status === "completed")
    await tx.insert(outboxEvents).values({
      type: "partner.proof.prepare",
      payload: { accountId: job.accountId, jobId: job.id },
    });
}
