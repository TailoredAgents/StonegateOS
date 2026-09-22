import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  outboxEvents,
  partnerBookingVisits,
  partnerCancellationRequests,
  type DatabaseClient,
} from "@/db";
import type { TeamMutationTransaction } from "./team-mutation";

type Reader = Pick<DatabaseClient, "select">;
type CancellationBinding = {
  accountId: string;
  bookingId: string;
  visitId: string;
  appointmentId: string;
  version: string;
  calendarEventId: string;
  sourceAuditEventId: string;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A visit cancellation requires a persisted, successful human authorization. */
async function verifySourceCancellation(
  db: Reader,
  input: CancellationBinding,
): Promise<boolean> {
  const [bound] = await db
    .select({ visit: partnerBookingVisits, appointment: appointments })
    .from(partnerBookingVisits)
    .innerJoin(
      appointments,
      eq(appointments.id, partnerBookingVisits.appointmentId),
    )
    .where(
      and(
        eq(partnerBookingVisits.id, input.visitId),
        eq(partnerBookingVisits.partnerAccountId, input.accountId),
        eq(partnerBookingVisits.partnerBookingId, input.bookingId),
        eq(partnerBookingVisits.appointmentId, input.appointmentId),
        eq(appointments.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (
    !bound ||
    bound.visit.status !== "canceled" ||
    bound.appointment.status !== "canceled" ||
    bound.appointment.updatedAt.toISOString() !== input.version ||
    bound.appointment.calendarEventId !== input.calendarEventId
  )
    return false;
  const [audit] = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, input.sourceAuditEventId))
    .limit(1);
  if (
    !audit ||
    audit.actorType !== "human" ||
    audit.outcome !== "succeeded" ||
    !audit.actorId ||
    !audit.sessionId ||
    !audit.correlationId ||
    !Array.isArray(audit.requiredPermissions)
  )
    return false;
  const meta = record(audit.meta),
    after = record(meta?.["after"]);
  const staff = ["team_session", "break_glass"].includes(
    audit.authMethod ?? "",
  );
  if (
    staff &&
    audit.action === "partner.multi_service.visit_status" &&
    audit.entityType === "partner_booking" &&
    audit.entityId === input.bookingId &&
    audit.requiredPermissions.includes("appointments.update")
  ) {
    return (
      meta?.["accountId"] === input.accountId &&
      meta["operation"] === "visit_status" &&
      after?.["bookingId"] === input.bookingId &&
      after["visitId"] === input.visitId &&
      after["status"] === "canceled"
    );
  }
  if (
    audit.authMethod === "partner_session" &&
    audit.action === "partner.booking.canceled" &&
    audit.entityType === "partner_booking" &&
    audit.entityId === input.bookingId &&
    audit.requiredPermissions.includes("bookings.cancel")
  ) {
    return (
      meta?.["partnerAccountId"] === input.accountId &&
      after?.["publicStatus"] === "canceled"
    );
  }
  if (
    staff &&
    audit.action === "partner_cancellation_request.decided" &&
    audit.entityType === "partner_cancellation_request" &&
    audit.entityId &&
    audit.requiredPermissions.includes(
      "partners.cancellation_requests.decide",
    ) &&
    meta?.["partnerAccountId"] === input.accountId &&
    meta["partnerBookingId"] === input.bookingId &&
    after?.["state"] === "approved" &&
    after["publicStatus"] === "canceled"
  ) {
    const [request] = await db
      .select({ id: partnerCancellationRequests.id })
      .from(partnerCancellationRequests)
      .where(
        and(
          eq(partnerCancellationRequests.id, audit.entityId),
          eq(partnerCancellationRequests.partnerAccountId, input.accountId),
          eq(partnerCancellationRequests.partnerBookingId, input.bookingId),
          eq(partnerCancellationRequests.state, "approved"),
        ),
      )
      .limit(1);
    return Boolean(request);
  }
  return false;
}

/** Match the exact immutable visit/appointment cancellation receipt at dispatch. */
export async function verifyPartnerVisitCalendarCancellation(
  db: Reader,
  input: CancellationBinding,
): Promise<boolean> {
  const [receipt] = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, input.sourceAuditEventId))
    .limit(1);
  const meta = record(receipt?.meta);
  if (
    !receipt ||
    receipt.action !== "partner.visit.calendar_cancellation_authorized" ||
    receipt.entityType !== "appointment" ||
    receipt.entityId !== input.appointmentId ||
    receipt.outcome !== "succeeded" ||
    meta?.["accountId"] !== input.accountId ||
    meta["bookingId"] !== input.bookingId ||
    meta["visitId"] !== input.visitId ||
    meta["version"] !== input.version ||
    meta["calendarEventId"] !== input.calendarEventId ||
    typeof meta["sourceAuditEventId"] !== "string"
  )
    return false;
  return verifySourceCancellation(db, {
    ...input,
    sourceAuditEventId: meta["sourceAuditEventId"],
  });
}

/** Called after the success audit, inside the same cancellation transaction. */
export async function queuePartnerVisitCalendarCancellations(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    bookingId: string;
    visitId?: string;
    changedAt: Date;
    sourceAuditEventId: string;
  },
) {
  const rows = await tx
    .select({ visit: partnerBookingVisits, appointment: appointments })
    .from(partnerBookingVisits)
    .innerJoin(
      appointments,
      eq(appointments.id, partnerBookingVisits.appointmentId),
    )
    .where(
      and(
        eq(partnerBookingVisits.partnerAccountId, input.accountId),
        eq(partnerBookingVisits.partnerBookingId, input.bookingId),
        input.visitId ? eq(partnerBookingVisits.id, input.visitId) : undefined,
        eq(partnerBookingVisits.status, "canceled"),
        eq(appointments.status, "canceled"),
        eq(appointments.updatedAt, input.changedAt),
      ),
    );
  for (const { visit, appointment } of rows) {
    if (!appointment.calendarEventId) continue;
    const binding = {
      accountId: input.accountId,
      bookingId: input.bookingId,
      visitId: visit.id,
      appointmentId: appointment.id,
      version: appointment.updatedAt.toISOString(),
      calendarEventId: appointment.calendarEventId,
      sourceAuditEventId: input.sourceAuditEventId,
    };
    if (!(await verifySourceCancellation(tx, binding)))
      throw new Error("partner_visit_cancellation_authorization_invalid");
    const [sourceAudit] = await tx
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, input.sourceAuditEventId))
      .limit(1);
    if (!sourceAudit)
      throw new Error("partner_visit_cancellation_audit_missing");
    const receiptId = randomUUID();
    await tx.insert(auditLogs).values({
      id: receiptId,
      actorType: sourceAudit.actorType,
      actorId: sourceAudit.actorId,
      sessionId: sourceAudit.sessionId,
      authMethod: sourceAudit.authMethod,
      correlationId: sourceAudit.correlationId,
      requiredPermissions: sourceAudit.requiredPermissions,
      outcome: "succeeded",
      action: "partner.visit.calendar_cancellation_authorized",
      entityType: "appointment",
      entityId: appointment.id,
      meta: binding,
      createdAt: input.changedAt,
    });
    await tx.insert(outboxEvents).values({
      type: "appointment.calendar_sync_requested",
      payload: {
        ...binding,
        sourceAuditEventId: receiptId,
        reason: "partner.visit.canceled",
        requestedCalendarEventId: binding.calendarEventId,
      },
      createdAt: input.changedAt,
    });
  }
}
