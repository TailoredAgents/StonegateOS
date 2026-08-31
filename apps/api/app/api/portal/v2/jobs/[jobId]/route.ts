import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  appointments,
  conversationThreads,
  getDb,
  mediaAssets,
  partnerAccountLocations,
  partnerBookings,
  partnerDocuments,
  partnerInvoices,
  partnerJobEvidence,
  partnerJobEvents,
  partnerProofPackages,
  partnerQuotes,
  properties,
} from "@/db";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import {
  evaluatePartnerCancellation,
  resolvePartnerCancellationPolicy,
  type PartnerCancellationAction,
} from "@/lib/partner-portal-v2-cancellation";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function allowedActions(input: {
  status: string;
  canUpdate: boolean;
  cancellationAction: PartnerCancellationAction;
  canMessage: boolean;
  canUpload: boolean;
  canShareProof: boolean;
  canDuplicate: boolean;
}): string[] {
  const terminal = ["completed", "canceled", "declined"].includes(input.status);
  return [
    ...(input.canUpdate && !terminal
      ? ["request_change", "reschedule", "edit_references"]
      : []),
    ...(input.cancellationAction ? [input.cancellationAction] : []),
    ...(input.canMessage ? ["message"] : []),
    ...(input.canUpload ? ["upload_media"] : []),
    ...(input.canShareProof ? ["create_proof_share"] : []),
    ...(input.canDuplicate ? ["duplicate"] : []),
  ];
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
  if (!principal.accountId) {
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
        status: partnerBookings.publicStatus,
        confirmationMode: partnerBookings.confirmationMode,
        serviceKey: partnerBookings.serviceKey,
        tierKey: partnerBookings.tierKey,
        addOns: partnerBookings.addOnsSnapshot,
        amountCents: partnerBookings.amountCents,
        currency: partnerBookings.currency,
        scope: partnerBookings.scopeSnapshot,
        proofRequirements: partnerBookings.proofRequirementsSnapshot,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
        projectReference: partnerBookings.projectReference,
        billingContact: partnerBookings.billingContactSnapshot,
        reviewReasons: partnerBookings.requestedReviewReasons,
        cancelOperationKeyHash: partnerBookings.cancelOperationKeyHash,
        arrivalStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalEndAt: partnerBookings.arrivalWindowEndAt,
        version: partnerBookings.version,
        createdAt: partnerBookings.createdAt,
        updatedAt: partnerBookings.updatedAt,
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
    const canReadDocuments = hasPartnerCapability(principal, "documents.read");
    const canReadInvoices = hasPartnerCapability(principal, "invoices.read");
    const canReadRates = hasPartnerCapability(principal, "rates.read");
    const canReadMessages = hasPartnerCapability(principal, "messages.read");
    const cancellation = evaluatePartnerCancellation({
      status: job.status,
      promisedArrivalStartAt: job.arrivalStartAt,
      now: new Date(),
      canCancel: hasPartnerCapability(principal, "bookings.cancel"),
      reviewPending:
        Boolean(job.cancelOperationKeyHash) && job.status !== "canceled",
      policy: resolvePartnerCancellationPolicy({ timezone: job.timezone }),
    });

    const [
      timeline,
      evidence,
      documents,
      invoices,
      quotes,
      proofPackages,
      thread,
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
    ]);
    const authorizedDocumentIds = new Set(documents.map((row) => row.id));

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
              ? createPortalV2MoneyDto(job.amountCents)
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
            total: createPortalV2MoneyDto(quote.totalCents),
            expiresAt: quote.expiresAt?.toISOString() ?? null,
          })),
          invoices: invoices.map((invoice) => ({
            id: invoice.id,
            number: invoice.number,
            status: invoice.status,
            total: createPortalV2MoneyDto(invoice.totalCents),
            paid: createPortalV2MoneyDto(invoice.paidCents),
            balance: createPortalV2MoneyDto(invoice.balanceCents),
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
          allowedActions: allowedActions({
            status: job.status,
            canUpdate: hasPartnerCapability(principal, "bookings.update"),
            cancellationAction: cancellation.action,
            canMessage: hasPartnerCapability(principal, "messages.send"),
            canUpload: hasPartnerCapability(principal, "media.upload"),
            canShareProof: canReadProof,
            canDuplicate: hasPartnerCapability(principal, "bookings.create"),
          }),
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
