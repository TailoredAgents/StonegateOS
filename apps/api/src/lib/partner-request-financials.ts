import { and, eq, sql } from "drizzle-orm";
import { appointments, partnerBookings, partnerBookingVisits } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "./team-mutation";

export const partnerRequestTotalSql = sql<
  number | null
>`case when ${partnerBookings.modelVersion} = 2 then coalesce(${partnerBookings.finalTotalCents}, ${partnerBookings.quotedTotalCents}) else coalesce(${appointments.finalTotalCents}, ${appointments.quotedTotalCents}) end`;

/** Acquire the new parent's lock before legacy global schedule/mutation locks. */
export async function lockMultiServiceRequestIfApplicable(
  tx: TeamMutationTransaction,
  accountId: string,
  bookingId: string,
) {
  const [binding] = await tx
    .select({ modelVersion: partnerBookings.modelVersion })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, bookingId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .limit(1);
  if (binding?.modelVersion === 2)
    await lockPartnerRequestFinancials(tx, accountId, bookingId);
}

/** All parent financial mutations take this lock before row/payment/invoice locks. */
export async function lockPartnerRequestFinancials(
  tx: TeamMutationTransaction,
  accountId: string,
  bookingId: string,
) {
  const [binding] = await tx
    .select({
      id: partnerBookings.id,
      modelVersion: partnerBookings.modelVersion,
      appointmentId: partnerBookings.appointmentId,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, bookingId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .limit(1);
  if (!binding)
    throw new TeamMutationFailure("invalid", "Request not found.", {
      status: 404,
    });
  if (binding.modelVersion === 2)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('partner_request_payment_collection'), hashtext(${bookingId}))`,
    );
  else {
    if (!binding.appointmentId)
      throw new TeamMutationFailure(
        "conflict",
        "This job's billing connection needs review.",
      );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('appointment_payment_collection'), hashtext(${binding.appointmentId}))`,
    );
  }
  const [parent] = await tx
    .select({
      quotedTotalCents: partnerBookings.quotedTotalCents,
      finalTotalCents: partnerBookings.finalTotalCents,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, bookingId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!parent)
    throw new TeamMutationFailure("invalid", "Request not found.", {
      status: 404,
    });
  if (binding.modelVersion === 2)
    return {
      ...binding,
      totalCents: parent.finalTotalCents ?? parent.quotedTotalCents,
    };
  const [appointment] = await tx
    .select({
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, binding.appointmentId!),
        eq(appointments.partnerAccountId, accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!appointment)
    throw new TeamMutationFailure("invalid", "Job not found.", { status: 404 });
  return {
    ...binding,
    totalCents: appointment.finalTotalCents ?? appointment.quotedTotalCents,
  };
}

/** A visit is operational only. Collection must be initiated from its parent bill. */
export async function assertAppointmentHasIndependentFinancials(
  tx: Pick<TeamMutationTransaction, "select">,
  appointmentId: string,
) {
  const [visit] = await tx
    .select({ bookingId: partnerBookingVisits.partnerBookingId })
    .from(partnerBookingVisits)
    .where(eq(partnerBookingVisits.appointmentId, appointmentId))
    .limit(1);
  if (visit)
    throw new TeamMutationFailure(
      "conflict",
      "This visit belongs to a partner request. Open that request to change its price, schedule, or completion.",
    );
}
