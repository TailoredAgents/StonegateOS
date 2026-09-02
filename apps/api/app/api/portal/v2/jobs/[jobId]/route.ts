import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  appointmentCrewMembers,
  appointments,
  conversationThreads,
  etaMessageDrafts,
  getDb,
  mediaAssets,
  partnerAccountCancellationPolicies,
  partnerAccountLocations,
  partnerBookings,
  partnerCancellationRequestReconciliationCases,
  partnerCancellationRequests,
  partnerDocuments,
  partnerInvoices,
  partnerJobChangeOrders,
  partnerJobEvidence,
  partnerJobChangeRequests,
  partnerJobEvents,
  partnerNotificationPreferences,
  partnerNotificationDeliveries,
  partnerProofPackages,
  partnerQuotes,
  partnerRescheduleRequests,
  properties,
} from "@/db";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import {
  evaluatePartnerCancellation,
  resolvePartnerCancellationPolicy,
  resolvePersistedPartnerAccountCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";
import {
  allowedPartnerJobActions,
  resolvePartnerJobActionAvailability,
} from "@/lib/partner-portal-v2-job-actions";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
} from "@/lib/partner-portal-v2-resource-authorization";
import { createPartnerPublicJobScheduleDto } from "@/lib/partner-portal-v2-scheduling/domain";
import { projectPartnerAddOnSnapshots } from "@/lib/partner-portal-v2-service-add-ons";
import {
  createPortalV2MoneyDto,
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  createPartnerJobNotificationDeliveryDto,
  createPartnerJobOperationsSummary,
} from "@/lib/partner-portal-v2-job-hub";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safePartnerPricingBasis(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const pricingState = snapshot["pricingState"];
  const agreementLabel = snapshot["agreementLabel"];
  const agreementRevision = snapshot["agreementRevision"];
  const effectiveFrom = snapshot["agreementEffectiveFrom"];
  const effectiveTo = snapshot["agreementEffectiveTo"];
  const finalPriceSource = snapshot["finalPriceSource"];
  if (
    !["contracted", "estimate", "quote_required", "standard_rate"].includes(
      typeof pricingState === "string" ? pricingState : "",
    ) ||
    typeof agreementLabel !== "string" ||
    agreementLabel.length < 1 ||
    agreementLabel.length > 160 ||
    !Number.isSafeInteger(agreementRevision) ||
    Number(agreementRevision) < 1 ||
    typeof effectiveFrom !== "string" ||
    Number.isNaN(new Date(effectiveFrom).getTime()) ||
    (effectiveTo !== null &&
      (typeof effectiveTo !== "string" ||
        Number.isNaN(new Date(effectiveTo).getTime()))) ||
    (finalPriceSource !== undefined &&
      finalPriceSource !== "accepted_change_order_quote_v2")
  ) {
    return null;
  }
  return {
    pricingState,
    agreementLabel,
    agreementRevision: Number(agreementRevision),
    effectiveFrom,
    effectiveTo,
    finalPriceSource:
      finalPriceSource === "accepted_change_order_quote_v2"
        ? finalPriceSource
        : null,
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "jobs.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const { jobId } = await context.params;
  if (!UUID_PATTERN.test(jobId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }

  try {
    const db = getDb();
    const [job] = await db
      .select({
        id: partnerBookings.id,
        appointmentId: partnerBookings.appointmentId,
        status: partnerBookings.publicStatus,
        confirmationMode: partnerBookings.confirmationMode,
        serviceKey: partnerBookings.serviceKey,
        tierKey: partnerBookings.tierKey,
        addOns: partnerBookings.addOnsSnapshot,
        amountCents: partnerBookings.amountCents,
        currency: partnerBookings.currency,
        rateSnapshot: partnerBookings.rateSnapshot,
        scope: partnerBookings.scopeSnapshot,
        proofRequirements: partnerBookings.proofRequirementsSnapshot,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
        projectReference: partnerBookings.projectReference,
        billingContact: partnerBookings.billingContactSnapshot,
        reviewReasons: partnerBookings.requestedReviewReasons,
        cancellationMinimumNoticeMinutes:
          partnerAccountCancellationPolicies.minimumNoticeMinutes,
        cancellationDirectEnabled:
          partnerAccountCancellationPolicies.directCancellationEnabled,
        cancellationLateDisposition:
          partnerAccountCancellationPolicies.lateCancellationDisposition,
        cancellationAutomaticFeeMinor:
          partnerAccountCancellationPolicies.automaticFeeMinor,
        cancellationPolicyRevision: partnerAccountCancellationPolicies.revision,
        arrivalStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalEndAt: partnerBookings.arrivalWindowEndAt,
        version: partnerBookings.version,
        createdAt: partnerBookings.createdAt,
        updatedAt: partnerBookings.updatedAt,
        appointmentStatus: appointments.status,
        appointmentCompletedAt: appointments.completedAt,
        locationId: partnerAccountLocations.id,
        siteName: partnerAccountLocations.siteName,
        externalPropertyId: partnerAccountLocations.externalPropertyId,
        addressLine1: properties.addressLine1,
        addressLine2: properties.addressLine2,
        city: properties.city,
        state: properties.state,
        postalCode: properties.postalCode,
        accessInstructions: partnerAccountLocations.accessInstructions,
        parkingInstructions: partnerAccountLocations.parkingInstructions,
        loadingInstructions: partnerAccountLocations.loadingInstructions,
        onSiteContact: partnerAccountLocations.onSiteContact,
        timezone: partnerAccountLocations.timezone,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .leftJoin(properties, eq(partnerBookings.propertyId, properties.id))
      .leftJoin(
        partnerAccountLocations,
        createPartnerJobLocationJoinCondition(),
      )
      .leftJoin(
        partnerAccountCancellationPolicies,
        eq(
          partnerAccountCancellationPolicies.partnerAccountId,
          partnerBookings.partnerAccountId,
        ),
      )
      .where(createPartnerJobAccessCondition(principal, jobId))
      .limit(1);
    if (!job) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }

    const canReadProof = hasPartnerCapability(principal, "proof.read");
    const canReadDocuments = hasPartnerCapability(
      principal,
      "documents.financial.read",
    );
    const canReadInvoices = hasPartnerCapability(principal, "invoices.read");
    const canReadRates =
      hasPartnerCapability(principal, "bookings.pricing.read") ||
      hasPartnerCapability(principal, "rates.read");
    const canReadMessages = hasPartnerCapability(principal, "messages.read");
    const [
      timeline,
      evidence,
      documents,
      invoices,
      quotes,
      proofPackages,
      thread,
      notificationPreference,
      pendingChangeRequest,
      pendingRescheduleRequest,
      pendingCancellationRequest,
      cancellationReconciliationCase,
      changeOrder,
      publishedEta,
      assignedTeamCount,
      notificationDeliveries,
    ] = await Promise.all([
      db
        .select({
          id: partnerJobEvents.id,
          type: partnerJobEvents.eventType,
          label: partnerJobEvents.publicLabel,
          detail: partnerJobEvents.publicDetail,
          at: partnerJobEvents.effectiveAt,
          actorType: partnerJobEvents.actorType,
        })
        .from(partnerJobEvents)
        .where(
          and(
            eq(partnerJobEvents.partnerAccountId, principal.accountId),
            eq(partnerJobEvents.partnerBookingId, job.id),
          ),
        )
        .orderBy(asc(partnerJobEvents.effectiveAt), asc(partnerJobEvents.id))
        .limit(200),
      canReadProof
        ? db
            .select({
              id: partnerJobEvidence.id,
              category: partnerJobEvidence.category,
              caption: partnerJobEvidence.caption,
              sortOrder: partnerJobEvidence.sortOrder,
              createdAt: partnerJobEvidence.createdAt,
              status: mediaAssets.status,
              filename: mediaAssets.originalFilename,
              contentType: mediaAssets.contentType,
              byteSize: mediaAssets.byteSize,
              width: mediaAssets.width,
              height: mediaAssets.height,
              readyAt: mediaAssets.readyAt,
            })
            .from(partnerJobEvidence)
            .innerJoin(
              mediaAssets,
              eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
            )
            .where(
              and(
                eq(partnerJobEvidence.partnerAccountId, principal.accountId),
                eq(partnerJobEvidence.partnerBookingId, job.id),
                isNull(partnerJobEvidence.deletedAt),
                isNull(mediaAssets.deletedAt),
              ),
            )
            .orderBy(
              asc(partnerJobEvidence.category),
              asc(partnerJobEvidence.sortOrder),
              asc(partnerJobEvidence.id),
            )
            .limit(40)
        : Promise.resolve([]),
      canReadDocuments
        ? db
            .select({
              id: partnerDocuments.id,
              type: partnerDocuments.documentType,
              version: partnerDocuments.version,
              filename: partnerDocuments.filename,
              contentType: partnerDocuments.contentType,
              byteSize: partnerDocuments.byteSize,
              sha256: partnerDocuments.sha256,
              generatedAt: partnerDocuments.generatedAt,
            })
            .from(partnerDocuments)
            .where(
              and(
                eq(partnerDocuments.partnerAccountId, principal.accountId),
                eq(partnerDocuments.partnerBookingId, job.id),
              ),
            )
            .orderBy(
              desc(partnerDocuments.generatedAt),
              desc(partnerDocuments.id),
            )
            .limit(100)
        : Promise.resolve([]),
      canReadInvoices
        ? db
            .select({
              id: partnerInvoices.id,
              number: partnerInvoices.invoiceNumber,
              status: partnerInvoices.status,
              currency: partnerInvoices.currency,
              totalCents: partnerInvoices.totalCents,
              paidCents: partnerInvoices.paidCents,
              balanceCents: partnerInvoices.balanceCents,
              dueDate: partnerInvoices.dueDate,
              issuedAt: partnerInvoices.issuedAt,
              paidAt: partnerInvoices.paidAt,
              hostedPaymentUrl: partnerInvoices.hostedPaymentUrl,
            })
            .from(partnerInvoices)
            .where(
              and(
                eq(partnerInvoices.partnerAccountId, principal.accountId),
                eq(partnerInvoices.partnerBookingId, job.id),
              ),
            )
            .orderBy(desc(partnerInvoices.createdAt), desc(partnerInvoices.id))
            .limit(20)
        : Promise.resolve([]),
      canReadRates
        ? db
            .select({
              id: partnerQuotes.id,
              number: partnerQuotes.quoteNumber,
              version: partnerQuotes.version,
              status: partnerQuotes.status,
              currency: partnerQuotes.currency,
              totalCents: partnerQuotes.totalCents,
              expiresAt: partnerQuotes.expiresAt,
            })
            .from(partnerQuotes)
            .where(
              and(
                eq(partnerQuotes.partnerAccountId, principal.accountId),
                eq(partnerQuotes.partnerBookingId, job.id),
                eq(partnerQuotes.authority, "legacy_snapshot"),
              ),
            )
            .orderBy(desc(partnerQuotes.version), desc(partnerQuotes.id))
            .limit(20)
        : Promise.resolve([]),
      canReadProof
        ? db
            .select({
              id: partnerProofPackages.id,
              version: partnerProofPackages.version,
              manifestSha256: partnerProofPackages.manifestSha256,
              generatedAt: partnerProofPackages.generatedAt,
              pdfDocumentId: partnerProofPackages.pdfDocumentId,
              zipDocumentId: partnerProofPackages.zipDocumentId,
            })
            .from(partnerProofPackages)
            .where(
              and(
                eq(partnerProofPackages.partnerAccountId, principal.accountId),
                eq(partnerProofPackages.partnerBookingId, job.id),
              ),
            )
            .orderBy(desc(partnerProofPackages.version))
            .limit(20)
        : Promise.resolve([]),
      canReadMessages
        ? db
            .select({
              id: conversationThreads.id,
              subject: conversationThreads.subject,
              lastMessageAt: conversationThreads.lastMessageAt,
            })
            .from(conversationThreads)
            .where(
              and(
                eq(conversationThreads.partnerAccountId, principal.accountId),
                eq(conversationThreads.partnerBookingId, job.id),
                eq(conversationThreads.portalVisible, true),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select({
          inAppEnabled: partnerNotificationPreferences.inAppEnabled,
          emailEnabled: partnerNotificationPreferences.emailEnabled,
          smsEnabled: partnerNotificationPreferences.smsEnabled,
          smsDestination: partnerNotificationPreferences.smsVerifiedPhoneE164,
        })
        .from(partnerNotificationPreferences)
        .where(
          and(
            eq(
              partnerNotificationPreferences.partnerAccountId,
              principal.accountId,
            ),
            eq(
              partnerNotificationPreferences.membershipId,
              principal.membershipId,
            ),
            eq(partnerNotificationPreferences.eventKey, "booking_created"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: partnerJobChangeRequests.id,
          state: partnerJobChangeRequests.state,
          reason: partnerJobChangeRequests.reason,
          revision: partnerJobChangeRequests.revision,
          createdAt: partnerJobChangeRequests.createdAt,
        })
        .from(partnerJobChangeRequests)
        .where(
          and(
            eq(partnerJobChangeRequests.partnerAccountId, principal.accountId),
            eq(partnerJobChangeRequests.partnerBookingId, job.id),
            eq(partnerJobChangeRequests.state, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: partnerRescheduleRequests.id })
        .from(partnerRescheduleRequests)
        .where(
          and(
            eq(partnerRescheduleRequests.partnerAccountId, principal.accountId),
            eq(partnerRescheduleRequests.partnerBookingId, job.id),
            eq(partnerRescheduleRequests.state, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: partnerCancellationRequests.id,
          state: partnerCancellationRequests.state,
          reason: partnerCancellationRequests.reason,
          revision: partnerCancellationRequests.revision,
          createdAt: partnerCancellationRequests.createdAt,
        })
        .from(partnerCancellationRequests)
        .where(
          and(
            eq(
              partnerCancellationRequests.partnerAccountId,
              principal.accountId,
            ),
            eq(partnerCancellationRequests.partnerBookingId, job.id),
            eq(partnerCancellationRequests.state, "pending"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: partnerCancellationRequestReconciliationCases.id })
        .from(partnerCancellationRequestReconciliationCases)
        .where(
          and(
            eq(
              partnerCancellationRequestReconciliationCases.partnerAccountId,
              principal.accountId,
            ),
            eq(
              partnerCancellationRequestReconciliationCases.partnerBookingId,
              job.id,
            ),
            eq(partnerCancellationRequestReconciliationCases.state, "open"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      canReadRates
        ? db
            .select({
              id: partnerJobChangeOrders.id,
              partnerQuoteId: partnerJobChangeOrders.partnerQuoteId,
              state: partnerJobChangeOrders.state,
              offer: partnerJobChangeOrders.offerSnapshot,
              resolution: partnerJobChangeOrders.resolutionSnapshot,
              revision: partnerJobChangeOrders.revision,
              createdAt: partnerJobChangeOrders.createdAt,
              resolvedAt: partnerJobChangeOrders.resolvedAt,
            })
            .from(partnerJobChangeOrders)
            .where(
              and(
                eq(
                  partnerJobChangeOrders.partnerAccountId,
                  principal.accountId,
                ),
                eq(partnerJobChangeOrders.partnerBookingId, job.id),
              ),
            )
            .orderBy(desc(partnerJobChangeOrders.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select({
          etaStartAt: etaMessageDrafts.etaStartAt,
          etaEndAt: etaMessageDrafts.etaEndAt,
          sentAt: etaMessageDrafts.sentAt,
        })
        .from(etaMessageDrafts)
        .where(
          and(
            eq(etaMessageDrafts.appointmentId, job.appointmentId),
            eq(etaMessageDrafts.status, "sent"),
            isNotNull(etaMessageDrafts.sentAt),
            isNotNull(etaMessageDrafts.etaStartAt),
            isNotNull(etaMessageDrafts.etaEndAt),
          ),
        )
        .orderBy(desc(etaMessageDrafts.sentAt), desc(etaMessageDrafts.id))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(appointmentCrewMembers)
        .where(eq(appointmentCrewMembers.appointmentId, job.appointmentId))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({
          id: partnerNotificationDeliveries.id,
          eventType: partnerNotificationDeliveries.eventType,
          channel: partnerNotificationDeliveries.channel,
          state: partnerNotificationDeliveries.state,
          createdAt: partnerNotificationDeliveries.createdAt,
          acceptedAt: partnerNotificationDeliveries.acceptedAt,
          updatedAt: partnerNotificationDeliveries.updatedAt,
        })
        .from(partnerNotificationDeliveries)
        .where(
          and(
            eq(
              partnerNotificationDeliveries.partnerAccountId,
              principal.accountId,
            ),
            eq(
              partnerNotificationDeliveries.membershipId,
              principal.membershipId,
            ),
            eq(partnerNotificationDeliveries.partnerBookingId, job.id),
          ),
        )
        .orderBy(
          desc(partnerNotificationDeliveries.createdAt),
          desc(partnerNotificationDeliveries.id),
        )
        .limit(50),
    ]);
    const operations = createPartnerJobOperationsSummary({
      jobStatus: job.status,
      assignedMemberCount: assignedTeamCount,
      publishedEta,
      now: new Date(),
    });
    const notificationDeliveryHistory = notificationDeliveries.flatMap(
      (delivery) => {
        const dto = createPartnerJobNotificationDeliveryDto(delivery);
        return dto ? [dto] : [];
      },
    );
    const authorizedDocumentIds = new Set(documents.map((row) => row.id));
    const cancellationReviewPending = Boolean(
      pendingCancellationRequest || cancellationReconciliationCase,
    );
    const cancellation = evaluatePartnerCancellation({
      status: job.status,
      promisedArrivalStartAt: job.arrivalStartAt,
      now: new Date(),
      canCancel: hasPartnerCapability(principal, "bookings.cancel"),
      reviewPending: cancellationReviewPending,
      policy: resolvePartnerCancellationPolicy({
        timezone: job.timezone,
        accountPolicy: resolvePersistedPartnerAccountCancellationPolicy(
          job.cancellationPolicyRevision !== null &&
            job.cancellationMinimumNoticeMinutes !== null &&
            job.cancellationDirectEnabled !== null &&
            job.cancellationLateDisposition !== null
            ? {
                minimumNoticeMinutes: job.cancellationMinimumNoticeMinutes,
                directCancellationEnabled: job.cancellationDirectEnabled,
                lateCancellationDisposition: job.cancellationLateDisposition,
                automaticFeeMinor: job.cancellationAutomaticFeeMinor,
                revision: job.cancellationPolicyRevision,
              }
            : null,
        ),
      }),
    });
    const actionAvailability = resolvePartnerJobActionAvailability({
      status: job.status,
      appointmentStatus: job.appointmentStatus,
      hasPromisedWindow: Boolean(job.arrivalStartAt && job.arrivalEndAt),
      proofAvailable: proofPackages.length > 0,
      revisionAvailable: true,
      changeRequestPending: Boolean(pendingChangeRequest),
      rescheduleReviewPending: Boolean(pendingRescheduleRequest),
      cancellationReviewPending,
      capabilities: {
        update: hasPartnerCapability(principal, "bookings.update"),
        requestChange: hasPartnerCapability(principal, "jobs.change_request"),
        editReferences: hasPartnerCapability(principal, "commercial.edit"),
        cancel: hasPartnerCapability(principal, "bookings.cancel"),
        message: hasPartnerCapability(principal, "messages.send"),
        uploadMedia: hasPartnerCapability(principal, "media.upload"),
        shareProof: canReadProof,
        duplicate: hasPartnerCapability(principal, "bookings.create"),
      },
      cancellation,
    });

    const etag = createPortalV2StrongEtag(
      `${job.id}:${job.version}:${job.updatedAt.toISOString()}`,
    );
    return NextResponse.json(
      {
        ok: true,
        correlationId,
        job: {
          id: job.id,
          status: job.status,
          confirmationMode: job.confirmationMode,
          service: {
            key: job.serviceKey,
            tierKey: job.tierKey,
            addOns: projectPartnerAddOnSnapshots(job.addOns).map((addOn) => ({
              key: addOn.key,
              label: addOn.label,
              unitLabel: addOn.unitLabel,
              quantity: addOn.quantity,
              requiresReview: addOn.requiresReview,
              unitAmount:
                canReadRates && addOn.unitAmountMinor !== null && addOn.currency
                  ? {
                      amountMinor: addOn.unitAmountMinor,
                      currency: addOn.currency,
                      minorUnit: 2,
                    }
                  : null,
              lineTotal:
                canReadRates && addOn.lineTotalMinor !== null && addOn.currency
                  ? {
                      amountMinor: addOn.lineTotalMinor,
                      currency: addOn.currency,
                      minorUnit: 2,
                    }
                  : null,
            })),
          },
          schedule: createPartnerPublicJobScheduleDto({
            arrivalWindowStartAt: job.arrivalStartAt,
            arrivalWindowEndAt: job.arrivalEndAt,
            timezone: job.timezone,
            completedAt: job.appointmentCompletedAt,
          }),
          operations,
          location: {
            id: job.locationId,
            name: job.siteName,
            externalPropertyId: job.externalPropertyId,
            address: job.addressLine1
              ? {
                  line1: job.addressLine1,
                  line2: job.addressLine2,
                  city: job.city,
                  state: job.state,
                  postalCode: job.postalCode,
                }
              : null,
            access: {
              instructions: job.accessInstructions,
              parking: job.parkingInstructions,
              loading: job.loadingInstructions,
            },
            onSiteContact: job.onSiteContact,
          },
          scope: job.scope,
          proofRequirements: job.proofRequirements,
          reviewReasons: job.reviewReasons,
          references: {
            poNumber: job.poNumber,
            costCenter: job.costCenter,
            project: job.projectReference,
            billingContact: canReadInvoices ? job.billingContact : null,
          },
          financial:
            canReadRates && job.amountCents !== null
              ? createPortalV2MoneyDto(job.amountCents, job.currency)
              : null,
          pricingBasis: canReadRates
            ? safePartnerPricingBasis(job.rateSnapshot)
            : null,
          timeline: timeline.map((event) => ({
            id: event.id,
            type: event.type,
            label: event.label,
            detail: event.detail,
            at: event.at.toISOString(),
            actorType: event.actorType,
          })),
          evidence: evidence.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            readyAt: item.readyAt?.toISOString() ?? null,
          })),
          proofPackages: proofPackages.map((proof) => ({
            ...proof,
            pdfDocumentId:
              proof.pdfDocumentId &&
              authorizedDocumentIds.has(proof.pdfDocumentId)
                ? proof.pdfDocumentId
                : null,
            zipDocumentId:
              proof.zipDocumentId &&
              authorizedDocumentIds.has(proof.zipDocumentId)
                ? proof.zipDocumentId
                : null,
            generatedAt: proof.generatedAt.toISOString(),
          })),
          documents: documents.map((document) => ({
            ...document,
            generatedAt: document.generatedAt.toISOString(),
          })),
          quotes: quotes.map((quote) => ({
            id: quote.id,
            number: quote.number,
            version: quote.version,
            status: quote.status,
            total: createPortalV2MoneyDto(quote.totalCents, quote.currency),
            expiresAt: quote.expiresAt?.toISOString() ?? null,
          })),
          invoices: invoices.map((invoice) => ({
            id: invoice.id,
            number: invoice.number,
            status: invoice.status,
            total: createPortalV2MoneyDto(invoice.totalCents, invoice.currency),
            paid: createPortalV2MoneyDto(invoice.paidCents, invoice.currency),
            balance: createPortalV2MoneyDto(
              invoice.balanceCents,
              invoice.currency,
            ),
            dueDate: invoice.dueDate,
            issuedAt: invoice.issuedAt?.toISOString() ?? null,
            paidAt: invoice.paidAt?.toISOString() ?? null,
            hostedPaymentUrl: invoice.hostedPaymentUrl,
          })),
          conversation: thread
            ? {
                threadId: thread.id,
                subject: thread.subject,
                lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
              }
            : null,
          cancellation,
          cancellationRequest: pendingCancellationRequest
            ? {
                id: pendingCancellationRequest.id,
                state: "pending" as const,
                reason: pendingCancellationRequest.reason,
                revision: pendingCancellationRequest.revision,
                createdAt: pendingCancellationRequest.createdAt.toISOString(),
              }
            : cancellationReconciliationCase
              ? {
                  id: null,
                  state: "reconciliation_required" as const,
                  reason: null,
                  revision: null,
                  createdAt: null,
                }
              : null,
          changeRequest: pendingChangeRequest
            ? {
                id: pendingChangeRequest.id,
                state: "pending" as const,
                reason: pendingChangeRequest.reason,
                revision: pendingChangeRequest.revision,
                createdAt: pendingChangeRequest.createdAt.toISOString(),
                consequence:
                  "The current job, price, proof requirements, and schedule remain unchanged while Stonegate reviews this request.",
              }
            : null,
          changeOrder: changeOrder
            ? {
                id: changeOrder.id,
                state: changeOrder.state,
                partnerQuoteId: changeOrder.partnerQuoteId,
                amount:
                  typeof changeOrder.offer.amountMinor === "number" &&
                  typeof changeOrder.offer.currency === "string"
                    ? createPortalV2MoneyDto(
                        changeOrder.offer.amountMinor,
                        changeOrder.offer.currency,
                      )
                    : null,
                operationalEffectsPending: Array.isArray(
                  changeOrder.resolution?.operationalEffectsPending,
                )
                  ? changeOrder.resolution.operationalEffectsPending.filter(
                      (effect) =>
                        effect === "schedule" ||
                        effect === "service" ||
                        effect === "proof",
                    )
                  : [],
                revision: changeOrder.revision,
                createdAt: changeOrder.createdAt.toISOString(),
                resolvedAt: changeOrder.resolvedAt?.toISOString() ?? null,
              }
            : null,
          notificationDestination: {
            inApp: notificationPreference?.inAppEnabled ?? true,
            email: {
              enabled: notificationPreference?.emailEnabled ?? true,
              destination: principal.email,
            },
            sms: {
              enabled:
                notificationPreference?.smsEnabled === true &&
                Boolean(notificationPreference.smsDestination),
              destination:
                notificationPreference?.smsEnabled === true &&
                notificationPreference.smsDestination
                  ? `•••• ${notificationPreference.smsDestination.slice(-4)}`
                  : null,
            },
            settingsPath: "/partners/settings#notifications",
          },
          notificationDeliveryHistory,
          actionAvailability,
          allowedActions: allowedPartnerJobActions(actionAvailability),
          revision: job.version,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "x-correlation-id": correlationId,
          ETag: etag,
          Vary: "Authorization",
        },
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] job detail failed", {
      correlationId,
      accountId: principal.accountId,
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
