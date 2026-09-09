import type { NextRequest } from "next/server";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import {
  appointments,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  payments,
  type DatabaseClient,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  partnerJobAccessScopeKey,
  type PartnerJobAuthorizationPrincipal,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type JobReader = Pick<DatabaseClient, "select">;

/** A boolean only: neither pending payment attempts nor legacy paid scalars qualify. */
export function partnerAdditionalServiceEligibilitySql(): SQL<boolean> {
  return sql<boolean>`(COALESCE(${appointments.partnerAccountId} = ${partnerBookings.partnerAccountId}, false) AND (
    ${partnerBookings.publicStatus} = 'completed'
    OR ${appointments.status} = 'completed'
    OR ${appointments.finalTotalCents} IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM ${payments}
      WHERE ${payments.appointmentId} = ${appointments.id}
        AND ${payments.canonicalStatus} = 'completed'
    )
  ))`;
}

/** Read inside the caller's transaction when creating or submitting a linked draft. */
export async function loadPartnerAdditionalServiceSource(
  db: JobReader,
  principal: PartnerJobAuthorizationPrincipal,
  jobId: string,
) {
  if (!UUID.test(jobId)) return null;
  const [row] = await db
    .select({
      id: partnerBookings.id,
      propertyId: partnerBookings.propertyId,
      locationId: partnerAccountLocations.id,
      status: partnerBookings.publicStatus,
      eligible: partnerAdditionalServiceEligibilitySql(),
    })
    .from(partnerBookings)
    .innerJoin(
      appointments,
      and(
        eq(appointments.id, partnerBookings.appointmentId),
        eq(appointments.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(createPartnerJobAccessCondition(principal, jobId))
    .limit(1);
  return row ?? null;
}

const summaryFields = {
  id: partnerBookings.id,
  status: partnerBookings.publicStatus,
  serviceKey: partnerBookings.serviceKey,
  createdAt: partnerBookings.createdAt,
};
type JobSummary = {
  id: string;
  status: string;
  serviceKey: string | null;
  createdAt: Date;
};
function summary(row: JobSummary) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** Links provide navigation only; every parent and child must independently pass job scope. */
export async function listPartnerAdditionalServiceLinks(
  db: JobReader,
  principal: PartnerJobAuthorizationPrincipal,
  jobId: string,
  params: URLSearchParams,
) {
  if (!UUID.test(jobId))
    return { ok: false, error: "not_found", status: 404 } as const;
  const scopeKey = partnerJobAccessScopeKey(principal);
  type Cursor = {
    id: string;
    createdAt: string;
    jobId: string;
    accountId: string;
    scopeKey: string;
  };
  const page = parsePortalV2Pagination<Cursor>(params, {
    cursorKind: "partner_additional_service_jobs",
    defaultLimit: 25,
    maximumLimit: 100,
    allowedQueryKeys: new Set(),
    validateCursorPayload(value: unknown): value is Cursor {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const cursor = value as Record<string, unknown>;
      return (
        cursor["accountId"] === principal.accountId &&
        cursor["scopeKey"] === scopeKey &&
        cursor["jobId"] === jobId &&
        typeof cursor["id"] === "string" &&
        UUID.test(cursor["id"]) &&
        typeof cursor["createdAt"] === "string" &&
        Number.isFinite(Date.parse(cursor["createdAt"]))
      );
    },
  });
  if (!page.ok)
    return { ok: false, error: "invalid_pagination", status: 400 } as const;
  const [requested] = await db
    .select({
      originalJobId: partnerBookings.additionalServiceFromPartnerBookingId,
    })
    .from(partnerBookings)
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(createPartnerJobAccessCondition(principal, jobId))
    .limit(1);
  if (!requested)
    return { ok: false, error: "not_found", status: 404 } as const;
  const originalRows = requested.originalJobId
    ? await db
        .select(summaryFields)
        .from(partnerBookings)
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .where(
          createPartnerJobAccessCondition(principal, requested.originalJobId),
        )
        .limit(1)
    : [];
  const cursor = page.cursor?.payload;
  const rows = await db
    .select(summaryFields)
    .from(partnerBookings)
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(
      and(
        createPartnerJobAccessCondition(principal),
        eq(partnerBookings.additionalServiceFromPartnerBookingId, jobId),
        cursor
          ? or(
              lt(partnerBookings.createdAt, new Date(cursor.createdAt)),
              and(
                eq(partnerBookings.createdAt, new Date(cursor.createdAt)),
                lt(partnerBookings.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerBookings.createdAt), desc(partnerBookings.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  const hasMore = rows.length > page.limit;
  return {
    ok: true,
    originalJob: originalRows[0] ? summary(originalRows[0]) : null,
    jobs: items.map(summary),
    page: {
      hasMore,
      limit: page.limit,
      nextCursor:
        hasMore && last
          ? encodePortalV2Cursor({
              kind: "partner_additional_service_jobs",
              limit: page.limit,
              payload: {
                id: last.id,
                createdAt: last.createdAt.toISOString(),
                jobId,
                accountId: principal.accountId,
                scopeKey,
              },
            })
          : null,
    },
  } as const;
}

export async function getPartnerAdditionalServiceLinks(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "jobs.read");
  if (!authorization.ok)
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  const { principal } = authorization;
  if (!principal.accountId || !principal.membershipId)
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId))
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  try {
    const result = await listPartnerAdditionalServiceLinks(
      getDb(),
      principal,
      (await context.params).jobId,
      request.nextUrl.searchParams,
    );
    if (!result.ok)
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    return createPartnerPortalV2SuccessResponse(result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
