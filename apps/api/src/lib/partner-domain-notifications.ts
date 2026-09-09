import { and, eq } from "drizzle-orm";
import {
  getDb,
  partnerAccounts,
  partnerBookings,
  appointments,
  type PartnerNotificationDeliveryEventType,
} from "@/db";
import { queuePartnerJobAudienceNotification } from "@/lib/partner-notification-delivery";

const EVENT_TYPES: Record<string, PartnerNotificationDeliveryEventType> = {
  "partner.invoice.issued": "billing.invoice_issued",
  "partner.invoice.credited": "billing.invoice_credited",
  "partner.payment.processing": "billing.payment_processing",
  "partner.payment.settled": "billing.payment_settled",
  "partner.payment.failed": "billing.payment_failed",
  "partner.payment.refunded": "billing.payment_refunded",
  "partner.proof.ready": "proof.ready",
  "partner.job.completed": "booking.completed",
  "partner.job.en_route": "booking.en_route",
  "partner.approval.requested": "approval.requested",
  "partner.approval.decided": "approval.decided",
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function processPartnerDomainNotification(input: {
  id: string;
  type: string;
  payload: unknown;
}): Promise<void> {
  const eventType = EVENT_TYPES[input.type];
  const payload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const accountId = payload["partnerAccountId"],
    jobId = payload["partnerBookingId"];
  if (
    !eventType ||
    typeof accountId !== "string" ||
    typeof jobId !== "string" ||
    !UUID.test(accountId) ||
    !UUID.test(jobId)
  )
    throw new Error("partner_domain_notification_binding_invalid");
  await getDb().transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: partnerBookings.id,
        timezone: appointments.schedulingTimezone,
        serviceAt: partnerBookings.arrivalWindowStartAt,
      })
      .from(partnerBookings)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerBookings.partnerAccountId),
      )
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .where(
        and(
          eq(partnerBookings.id, jobId),
          eq(partnerBookings.partnerAccountId, accountId),
        ),
      )
      .limit(1);
    if (!job) return;
    await queuePartnerJobAudienceNotification({
      tx,
      accountId,
      partnerBookingId: jobId,
      eventType,
      dedupeKey: input.id,
      correlationId: null,
      occurredAt: new Date(),
      accountTimezone: job.timezone,
      serviceAt: job.serviceAt,
    });
  });
}
