import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  appointments,
  getDb,
  partnerAccountCancellationPolicies,
  partnerAccountLocations,
  partnerBookings,
  partnerCancellationRequestReconciliationCases,
  partnerCancellationRequests,
  partnerJobChangeRequests,
  partnerProofPackages,
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
  partnerJobAccessScopeKey,
} from "@/lib/partner-portal-v2-resource-authorization";
import { createPartnerPublicJobScheduleDto } from "@/lib/partner-portal-v2-scheduling/domain";
import { projectPartnerAddOnSnapshots } from "@/lib/partner-portal-v2-service-add-ons";
import {
  createPortalV2ErrorResponse,
  createPortalV2MoneyDto,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const JOB_STATUSES = new Set([
  "requested",
  "approval_needed",
  "under_review",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "canceled",
  "declined",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DUPLICATE_QUERY_VALUE = Symbol("duplicate_query_value");
const ALLOWED_QUERY_KEYS = new Set([
  "status",
  "serviceKey",
  "locationId",
  "from",
  "to",
  "search",
]);

type JobCursorPayload = {
  accountId: string;
  filterHash: string;
  createdAt: string;
  id: string;
};

function isJobCursorPayload(value: unknown): value is JobCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "accountId,createdAt,filterHash,id" &&
    typeof record["accountId"] === "string" &&
    UUID_PATTERN.test(record["accountId"]) &&
    typeof record["filterHash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["filterHash"]) &&
    typeof record["createdAt"] === "string" &&
    Number.isFinite(Date.parse(record["createdAt"])) &&
    typeof record["id"] === "string" &&
    UUID_PATTERN.test(record["id"])
  );
}

function singleQueryValue(
  params: URLSearchParams,
  key: string,
): string | null | typeof DUPLICATE_QUERY_VALUE {
  const values = params.getAll(key);
  if (values.length > 1) return DUPLICATE_QUERY_VALUE;
  return values[0]?.trim() || null;
}

function statusQueryValues(value: string | null): string[] | null {
  if (!value) return null;
  const statuses = value.split(",").map((entry) => entry.trim());
  if (
    statuses.length === 0 ||
    statuses.length > JOB_STATUSES.size ||
    statuses.some((status) => !status || !JOB_STATUSES.has(status)) ||
    new Set(statuses).size !== statuses.length
  ) {
    return null;
  }
  return statuses.sort();
}

function descriptorResponse(
  failure: ReturnType<typeof createPortalV2ErrorResponse>,
): Response {
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers: { ...failure.headers, Vary: "Authorization" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
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

  const params = request.nextUrl.searchParams;
  const pagination = parsePortalV2Pagination(params, {
    cursorKind: "partner_jobs",
    validateCursorPayload: isJobCursorPayload,
    defaultLimit: 25,
    maximumLimit: 100,
    allowedQueryKeys: ALLOWED_QUERY_KEYS,
  });
  if (!pagination.ok) {
    return descriptorResponse(
      createPortalV2ErrorResponse("invalid_cursor", correlationId, {
        fieldErrors: pagination.fieldErrors,
      }),
    );
  }

  const status = singleQueryValue(params, "status");
  const serviceKey = singleQueryValue(params, "serviceKey");
  const locationId = singleQueryValue(params, "locationId");
  const from = singleQueryValue(params, "from");
  const to = singleQueryValue(params, "to");
  const search = singleQueryValue(params, "search");
  if (
    [status, serviceKey, locationId, from, to, search].includes(
      DUPLICATE_QUERY_VALUE,
    )
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const statuses =
    status && status !== DUPLICATE_QUERY_VALUE
      ? statusQueryValues(status)
      : null;
  if (
    (status && status !== DUPLICATE_QUERY_VALUE && !statuses) ||
    (serviceKey &&
      serviceKey !== DUPLICATE_QUERY_VALUE &&
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(serviceKey)) ||
    (locationId &&
      locationId !== DUPLICATE_QUERY_VALUE &&
      !UUID_PATTERN.test(locationId)) ||
    (search && search !== DUPLICATE_QUERY_VALUE && search.length > 100)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const fromDate =
    from && from !== DUPLICATE_QUERY_VALUE ? new Date(from) : null;
  const toDate = to && to !== DUPLICATE_QUERY_VALUE ? new Date(to) : null;
  if (
    (fromDate && !Number.isFinite(fromDate.getTime())) ||
    (toDate && !Number.isFinite(toDate.getTime())) ||
    (fromDate && toDate && fromDate > toDate)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  const normalizedFilters = {
    statuses,
    serviceKey: serviceKey === DUPLICATE_QUERY_VALUE ? null : serviceKey,
    locationId: locationId === DUPLICATE_QUERY_VALUE ? null : locationId,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    search:
      search === DUPLICATE_QUERY_VALUE ? null : (search?.toLowerCase() ?? null),
    authorizationScope: partnerJobAccessScopeKey(principal),
  };
  const filterHash = createHash("sha256")
    .update(JSON.stringify(normalizedFilters), "utf8")
    .digest("hex");
  if (
    pagination.cursor &&
    (pagination.cursor.payload.accountId !== principal.accountId ||
      pagination.cursor.payload.filterHash !== filterHash)
  ) {
    return descriptorResponse(
      createPortalV2ErrorResponse("invalid_cursor", correlationId, {
        fieldErrors: {
          cursor: "This page cursor belongs to another account or filter.",
        },
      }),
    );
  }

  try {
    const cursorCreatedAt = pagination.cursor
      ? new Date(pagination.cursor.payload.createdAt)
      : null;
    const cursorId = pagination.cursor?.payload.id ?? null;
    const db = getDb();
    const rows = await db
      .select({
        id: partnerBookings.id,
        status: partnerBookings.publicStatus,
        confirmationMode: partnerBookings.confirmationMode,
        serviceKey: partnerBookings.serviceKey,
        tierKey: partnerBookings.tierKey,
        addOns: partnerBookings.addOnsSnapshot,
        amountCents: partnerBookings.amountCents,
        currency: partnerBookings.currency,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
        projectReference: partnerBookings.projectReference,
        cancellationMinimumNoticeMinutes:
          partnerAccountCancellationPolicies.minimumNoticeMinutes,
        cancellationDirectEnabled:
          partnerAccountCancellationPolicies.directCancellationEnabled,
        cancellationLateDisposition:
          partnerAccountCancellationPolicies.lateCancellationDisposition,
        cancellationAutomaticFeeMinor:
          partnerAccountCancellationPolicies.automaticFeeMinor,
        cancellationPolicyRevision: partnerAccountCancellationPolicies.revision,
        appointmentStatus: appointments.status,
        arrivalStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalEndAt: partnerBookings.arrivalWindowEndAt,
        createdAt: partnerBookings.createdAt,
        updatedAt: partnerBookings.updatedAt,
        locationId: partnerAccountLocations.id,
        siteName: partnerAccountLocations.siteName,
        timezone: partnerAccountLocations.timezone,
        addressLine1: properties.addressLine1,
        city: properties.city,
        state: properties.state,
        postalCode: properties.postalCode,
        completedAt: appointments.completedAt,
        pendingRescheduleRequestId: partnerRescheduleRequests.id,
        pendingChangeRequestId: partnerJobChangeRequests.id,
        pendingChangeRequestReason: partnerJobChangeRequests.reason,
        pendingChangeRequestRevision: partnerJobChangeRequests.revision,
        pendingChangeRequestCreatedAt: partnerJobChangeRequests.createdAt,
        pendingCancellationRequestId: partnerCancellationRequests.id,
        pendingCancellationRequestReason: partnerCancellationRequests.reason,
        pendingCancellationRequestRevision:
          partnerCancellationRequests.revision,
        pendingCancellationRequestCreatedAt:
          partnerCancellationRequests.createdAt,
        cancellationReconciliationCaseId:
          partnerCancellationRequestReconciliationCases.id,
        proofAvailable: sql<boolean>`exists (
          select 1
          from ${partnerProofPackages}
          where ${partnerProofPackages.partnerAccountId} = ${partnerBookings.partnerAccountId}
            and ${partnerProofPackages.partnerBookingId} = ${partnerBookings.id}
        )`,
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
      .leftJoin(
        partnerRescheduleRequests,
        and(
          eq(
            partnerRescheduleRequests.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
          eq(partnerRescheduleRequests.partnerBookingId, partnerBookings.id),
          eq(partnerRescheduleRequests.state, "pending"),
        ),
      )
      .leftJoin(
        partnerCancellationRequests,
        and(
          eq(
            partnerCancellationRequests.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
          eq(partnerCancellationRequests.partnerBookingId, partnerBookings.id),
          eq(partnerCancellationRequests.state, "pending"),
        ),
      )
      .leftJoin(
        partnerJobChangeRequests,
        and(
          eq(
            partnerJobChangeRequests.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
          eq(partnerJobChangeRequests.partnerBookingId, partnerBookings.id),
          eq(partnerJobChangeRequests.state, "pending"),
        ),
      )
      .leftJoin(
        partnerCancellationRequestReconciliationCases,
        and(
          eq(
            partnerCancellationRequestReconciliationCases.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
          eq(
            partnerCancellationRequestReconciliationCases.partnerBookingId,
            partnerBookings.id,
          ),
          eq(partnerCancellationRequestReconciliationCases.state, "open"),
        ),
      )
      .where(
        and(
          createPartnerJobAccessCondition(principal),
          normalizedFilters.statuses
            ? inArray(partnerBookings.publicStatus, normalizedFilters.statuses)
            : undefined,
          normalizedFilters.serviceKey
            ? eq(partnerBookings.serviceKey, normalizedFilters.serviceKey)
            : undefined,
          normalizedFilters.locationId
            ? eq(partnerAccountLocations.id, normalizedFilters.locationId)
            : undefined,
          fromDate ? gte(appointments.startAt, fromDate) : undefined,
          toDate ? lte(appointments.startAt, toDate) : undefined,
          normalizedFilters.search
            ? or(
                ilike(
                  partnerAccountLocations.siteName,
                  `%${normalizedFilters.search}%`,
                ),
                ilike(properties.addressLine1, `%${normalizedFilters.search}%`),
                ilike(
                  partnerBookings.poNumber,
                  `%${normalizedFilters.search}%`,
                ),
                ilike(
                  partnerBookings.projectReference,
                  `%${normalizedFilters.search}%`,
                ),
              )
            : undefined,
          cursorCreatedAt && cursorId
            ? or(
                lt(partnerBookings.createdAt, cursorCreatedAt),
                and(
                  eq(partnerBookings.createdAt, cursorCreatedAt),
                  lt(partnerBookings.id, cursorId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(partnerBookings.createdAt), desc(partnerBookings.id))
      .limit(pagination.limit + 1);

    const hasMore = rows.length > pagination.limit;
    const page = hasMore ? rows.slice(0, pagination.limit) : rows;
    const last = page.at(-1);
    const canReadRates =
      hasPartnerCapability(principal, "bookings.pricing.read") ||
      hasPartnerCapability(principal, "rates.read");
    const canCancel = hasPartnerCapability(principal, "bookings.cancel");
    const actionCapabilities = {
      update: hasPartnerCapability(principal, "bookings.update"),
      requestChange: hasPartnerCapability(principal, "jobs.change_request"),
      editReferences: hasPartnerCapability(principal, "commercial.edit"),
      cancel: canCancel,
      message: hasPartnerCapability(principal, "messages.send"),
      uploadMedia: hasPartnerCapability(principal, "media.upload"),
      shareProof: hasPartnerCapability(principal, "proof.read"),
      duplicate: hasPartnerCapability(principal, "bookings.create"),
    };
    const evaluatedAt = new Date();
    const jobs = page.map((row) => {
      const cancellationReviewPending = Boolean(
        row.pendingCancellationRequestId ||
          row.cancellationReconciliationCaseId,
      );
      const cancellation = evaluatePartnerCancellation({
        status: row.status,
        promisedArrivalStartAt: row.arrivalStartAt,
        now: evaluatedAt,
        canCancel,
        reviewPending: cancellationReviewPending,
        policy: resolvePartnerCancellationPolicy({
          timezone: row.timezone,
          accountPolicy: resolvePersistedPartnerAccountCancellationPolicy(
            row.cancellationPolicyRevision !== null &&
              row.cancellationMinimumNoticeMinutes !== null &&
              row.cancellationDirectEnabled !== null &&
              row.cancellationLateDisposition !== null
              ? {
                  minimumNoticeMinutes: row.cancellationMinimumNoticeMinutes,
                  directCancellationEnabled: row.cancellationDirectEnabled,
                  lateCancellationDisposition: row.cancellationLateDisposition,
                  automaticFeeMinor: row.cancellationAutomaticFeeMinor,
                  revision: row.cancellationPolicyRevision,
                }
              : null,
          ),
        }),
      });
      const actionAvailability = resolvePartnerJobActionAvailability({
        status: row.status,
        appointmentStatus: row.appointmentStatus,
        hasPromisedWindow: Boolean(row.arrivalStartAt && row.arrivalEndAt),
        proofAvailable: row.proofAvailable,
        revisionAvailable: true,
        changeRequestPending: Boolean(row.pendingChangeRequestId),
        rescheduleReviewPending: Boolean(row.pendingRescheduleRequestId),
        cancellationReviewPending,
        capabilities: actionCapabilities,
        cancellation,
      });
      return {
        id: row.id,
        status: row.status,
        confirmationMode: row.confirmationMode,
        service: {
          key: row.serviceKey,
          tierKey: row.tierKey,
          addOns: projectPartnerAddOnSnapshots(row.addOns).map((addOn) => ({
            key: addOn.key,
            label: addOn.label,
            unitLabel: addOn.unitLabel,
            quantity: addOn.quantity,
            requiresReview: addOn.requiresReview,
          })),
        },
        schedule: createPartnerPublicJobScheduleDto({
          arrivalWindowStartAt: row.arrivalStartAt,
          arrivalWindowEndAt: row.arrivalEndAt,
          timezone: row.timezone,
          completedAt: row.completedAt,
        }),
        location: {
          id: row.locationId,
          name: row.siteName,
          address: row.addressLine1
            ? {
                line1: row.addressLine1,
                city: row.city,
                state: row.state,
                postalCode: row.postalCode,
              }
            : null,
        },
        references: {
          poNumber: row.poNumber,
          costCenter: row.costCenter,
          project: row.projectReference,
        },
        financial:
          canReadRates && row.amountCents !== null
            ? createPortalV2MoneyDto(row.amountCents, row.currency)
            : null,
        cancellation,
        cancellationRequest: row.pendingCancellationRequestId
          ? {
              id: row.pendingCancellationRequestId,
              state: "pending" as const,
              reason: row.pendingCancellationRequestReason,
              revision: row.pendingCancellationRequestRevision,
              createdAt:
                row.pendingCancellationRequestCreatedAt?.toISOString() ?? null,
            }
          : row.cancellationReconciliationCaseId
            ? {
                id: null,
                state: "reconciliation_required" as const,
                reason: null,
                revision: null,
                createdAt: null,
              }
            : null,
        changeRequest: row.pendingChangeRequestId
          ? {
              id: row.pendingChangeRequestId,
              state: "pending" as const,
              reason: row.pendingChangeRequestReason,
              revision: row.pendingChangeRequestRevision,
              createdAt:
                row.pendingChangeRequestCreatedAt?.toISOString() ?? null,
              consequence:
                "The current job, price, proof requirements, and schedule remain unchanged while Stonegate reviews this request.",
            }
          : null,
        actionAvailability,
        allowedActions: allowedPartnerJobActions(actionAvailability),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
    const nextCursor =
      hasMore && last
        ? encodePortalV2Cursor({
            kind: "partner_jobs",
            limit: pagination.limit,
            payload: {
              accountId: principal.accountId,
              filterHash,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            } satisfies JobCursorPayload,
          })
        : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        jobs,
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] jobs list failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
