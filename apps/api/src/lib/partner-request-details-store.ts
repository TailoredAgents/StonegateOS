import type { PartnerRequestDetails } from "@myst-os/sdk";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  appointments,
  getDb,
  mediaAssets,
  partnerAccounts,
  partnerBookingDrafts,
  partnerBookings,
  partnerJobEvidence,
  partnerServiceCatalog,
} from "@/db";
import { buildPartnerRequestDetails } from "./partner-request-details";

/** Batch reads stay inside the already authorized appointment set and account joins. */
export async function loadPartnerRequestDetailsForAppointments(
  appointmentIds: readonly string[],
  visibility: PartnerRequestDetails["visibility"],
): Promise<Map<string, PartnerRequestDetails>> {
  const result = new Map<string, PartnerRequestDetails>();
  const ids = [...new Set(appointmentIds)];
  const db = getDb();
  const original = alias(partnerBookings, "request_details_original_job");
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await db
      .select({
        appointmentId: appointments.id,
        jobId: partnerBookings.id,
        accountId: partnerAccounts.id,
        accountName: partnerAccounts.name,
        serviceKey: partnerBookings.serviceKey,
        serviceLabel: partnerServiceCatalog.label,
        tierKey: partnerBookings.tierKey,
        publicStatus: partnerBookings.publicStatus,
        confirmationMode: partnerBookings.confirmationMode,
        originalJobId: original.id,
        scopeSnapshot: partnerBookings.scopeSnapshot,
        rateSnapshot: partnerBookings.rateSnapshot,
        addOnsSnapshot: partnerBookings.addOnsSnapshot,
        proofRequirementsSnapshot: partnerBookings.proofRequirementsSnapshot,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
        projectReference: partnerBookings.projectReference,
        billingContactSnapshot: partnerBookings.billingContactSnapshot,
        appointmentStatus: appointments.status,
        appointmentStartAt: appointments.startAt,
        schedulingTimezone: appointments.schedulingTimezone,
        promisedArrivalStartAt: appointments.promisedArrivalStartAt,
        promisedArrivalEndAt: appointments.promisedArrivalEndAt,
        arrivalWindowStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalWindowEndAt: partnerBookings.arrivalWindowEndAt,
        draftPreferredWindows: partnerBookingDrafts.preferredWindows,
        draftAssistancePreference:
          partnerBookingDrafts.scheduleAssistancePreference,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        and(
          eq(appointments.id, partnerBookings.appointmentId),
          eq(appointments.partnerAccountId, partnerBookings.partnerAccountId),
        ),
      )
      .innerJoin(
        partnerAccounts,
        eq(partnerAccounts.id, partnerBookings.partnerAccountId),
      )
      .leftJoin(
        partnerServiceCatalog,
        eq(partnerServiceCatalog.key, partnerBookings.serviceKey),
      )
      .leftJoin(
        partnerBookingDrafts,
        and(
          eq(partnerBookingDrafts.id, partnerBookings.bookingDraftId),
          eq(
            partnerBookingDrafts.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
        ),
      )
      .leftJoin(
        original,
        and(
          eq(
            original.id,
            partnerBookings.additionalServiceFromPartnerBookingId,
          ),
          eq(original.partnerAccountId, partnerBookings.partnerAccountId),
        ),
      )
      .where(inArray(appointments.id, ids.slice(offset, offset + 500)));
    if (!rows.length) continue;
    const counts = await db
      .select({ jobId: partnerJobEvidence.partnerBookingId, total: count() })
      .from(partnerJobEvidence)
      .innerJoin(
        partnerBookings,
        and(
          eq(partnerBookings.id, partnerJobEvidence.partnerBookingId),
          eq(
            partnerBookings.partnerAccountId,
            partnerJobEvidence.partnerAccountId,
          ),
        ),
      )
      .innerJoin(
        mediaAssets,
        and(
          eq(mediaAssets.id, partnerJobEvidence.mediaAssetId),
          eq(mediaAssets.partnerAccountId, partnerJobEvidence.partnerAccountId),
        ),
      )
      .where(
        and(
          inArray(
            partnerBookings.id,
            rows.map((row) => row.jobId),
          ),
          isNull(partnerJobEvidence.deletedAt),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .groupBy(partnerJobEvidence.partnerBookingId);
    const byJob = new Map(counts.map((row) => [row.jobId, row.total]));
    for (const row of rows)
      result.set(
        row.appointmentId,
        buildPartnerRequestDetails(row, visibility, byJob.get(row.jobId) ?? 0),
      );
  }
  return result;
}
