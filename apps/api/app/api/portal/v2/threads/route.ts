import type { NextRequest } from "next/server";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversationThreads,
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerNotifications,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  partnerJobAccessScopeKey,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  createPortalV2ErrorResponse,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ThreadCursor = {
  accessScopeKey: string;
  accountId: string;
  updatedAt: string;
  id: string;
};

function isThreadCursor(value: unknown): value is ThreadCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") ===
      "accessScopeKey,accountId,id,updatedAt" &&
    typeof row["accessScopeKey"] === "string" &&
    row["accessScopeKey"].length <= 4_096 &&
    typeof row["accountId"] === "string" &&
    UUID_PATTERN.test(row["accountId"]) &&
    typeof row["id"] === "string" &&
    UUID_PATTERN.test(row["id"]) &&
    typeof row["updatedAt"] === "string" &&
    Number.isFinite(Date.parse(row["updatedAt"]))
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "messages.read",
  );
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
  const pagination = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: "partner_threads",
    validateCursorPayload: isThreadCursor,
    defaultLimit: 25,
    maximumLimit: 100,
    allowedQueryKeys: new Set(),
  });
  if (!pagination.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_cursor", correlationId, {
        fieldErrors: pagination.fieldErrors,
      }),
    );
  }
  if (
    pagination.cursor &&
    (pagination.cursor.payload.accountId !== principal.accountId ||
      pagination.cursor.payload.accessScopeKey !==
        partnerJobAccessScopeKey(principal))
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_cursor",
      422,
      correlationId,
    );
  }
  try {
    const cursorAt = pagination.cursor
      ? new Date(pagination.cursor.payload.updatedAt)
      : null;
    const cursorId = pagination.cursor?.payload.id ?? null;
    const db = getDb();
    const rows = await db
      .select({
        id: conversationThreads.id,
        jobId: conversationThreads.partnerBookingId,
        status: conversationThreads.status,
        updatedAt: conversationThreads.updatedAt,
        jobStatus: partnerBookings.publicStatus,
        serviceKey: partnerBookings.serviceKey,
        arrivalStartAt: partnerBookings.arrivalWindowStartAt,
        arrivalEndAt: partnerBookings.arrivalWindowEndAt,
      })
      .from(conversationThreads)
      .innerJoin(
        partnerBookings,
        and(
          eq(conversationThreads.partnerBookingId, partnerBookings.id),
          eq(
            conversationThreads.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
        ),
      )
      .leftJoin(
        partnerAccountLocations,
        createPartnerJobLocationJoinCondition(),
      )
      .where(
        and(
          eq(conversationThreads.partnerAccountId, principal.accountId),
          createPartnerJobAccessCondition(principal),
          eq(conversationThreads.portalVisible, true),
          cursorAt && cursorId
            ? or(
                lt(conversationThreads.updatedAt, cursorAt),
                and(
                  eq(conversationThreads.updatedAt, cursorAt),
                  lt(conversationThreads.id, cursorId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(conversationThreads.updatedAt),
        desc(conversationThreads.id),
      )
      .limit(pagination.limit + 1);
    const hasMore = rows.length > pagination.limit;
    const pageRows = hasMore ? rows.slice(0, pagination.limit) : rows;
    const threadIds = pageRows.map((row) => row.id);
    const jobIds = pageRows.flatMap((row) => (row.jobId ? [row.jobId] : []));
    const [messageRows, unreadRows] = await Promise.all([
      threadIds.length
        ? db
            .select({
              threadId: conversationMessages.threadId,
              id: conversationMessages.id,
              authorType: conversationMessages.authorType,
              body: conversationMessages.body,
              deliveryStatus: conversationMessages.deliveryStatus,
              createdAt: conversationMessages.createdAt,
            })
            .from(conversationMessages)
            .where(
              and(
                inArray(conversationMessages.threadId, threadIds),
                eq(conversationMessages.portalVisible, true),
              ),
            )
            .orderBy(
              desc(conversationMessages.createdAt),
              desc(conversationMessages.id),
            )
            .limit(Math.min(threadIds.length * 20, 2_000))
        : Promise.resolve([]),
      jobIds.length
        ? db
            .select({
              jobId: partnerNotifications.partnerBookingId,
              count: sql<number>`count(*)::int`,
            })
            .from(partnerNotifications)
            .where(
              and(
                eq(partnerNotifications.partnerAccountId, principal.accountId),
                eq(partnerNotifications.membershipId, principal.membershipId),
                inArray(partnerNotifications.partnerBookingId, jobIds),
                isNull(partnerNotifications.readAt),
                eq(partnerNotifications.eventKey, "message.received"),
              ),
            )
            .groupBy(partnerNotifications.partnerBookingId)
        : Promise.resolve([]),
    ]);
    const latestMessage = new Map<string, (typeof messageRows)[number]>();
    for (const message of messageRows) {
      if (!latestMessage.has(message.threadId)) {
        latestMessage.set(message.threadId, message);
      }
    }
    const unreadByJob = new Map<string, number>();
    for (const row of unreadRows) {
      if (row.jobId) unreadByJob.set(row.jobId, row.count);
    }
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePortalV2Cursor({
            kind: "partner_threads",
            limit: pagination.limit,
            payload: {
              accessScopeKey: partnerJobAccessScopeKey(principal),
              accountId: principal.accountId,
              updatedAt: last.updatedAt.toISOString(),
              id: last.id,
            } satisfies ThreadCursor,
          })
        : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        threads: pageRows.map((row) => {
          const message = latestMessage.get(row.id);
          return {
            id: row.id,
            job: {
              id: row.jobId,
              status: row.jobStatus,
              serviceKey: row.serviceKey,
              arrivalWindow:
                row.arrivalStartAt && row.arrivalEndAt
                  ? {
                      startAt: row.arrivalStartAt.toISOString(),
                      endAt: row.arrivalEndAt.toISOString(),
                      timezone: "America/New_York",
                    }
                  : null,
            },
            status: row.status,
            latestMessage: message
              ? {
                  id: message.id,
                  authorType: message.authorType,
                  preview: message.body.slice(0, 280),
                  deliveryStatus: message.deliveryStatus,
                  createdAt: message.createdAt.toISOString(),
                }
              : null,
            unreadCount: row.jobId ? (unreadByJob.get(row.jobId) ?? 0) : 0,
          };
        }),
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
