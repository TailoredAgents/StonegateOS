import type { NextRequest } from "next/server";
import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerNotifications,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobLocationJoinCondition,
  createPartnerNotificationAccessCondition,
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
const STATES = new Set(["all", "unread", "read"] as const);
type NotificationState = "all" | "unread" | "read";
type NotificationCursor = {
  accessScopeKey: string;
  accountId: string;
  membershipId: string;
  state: NotificationState;
  createdAt: string;
  id: string;
};

function isNotificationCursor(value: unknown): value is NotificationCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") ===
      "accessScopeKey,accountId,createdAt,id,membershipId,state" &&
    typeof row["accessScopeKey"] === "string" &&
    /^(?:account|scoped:[A-Za-z0-9_-]{43})$/u.test(row["accessScopeKey"]) &&
    typeof row["accountId"] === "string" &&
    UUID_PATTERN.test(row["accountId"]) &&
    typeof row["membershipId"] === "string" &&
    UUID_PATTERN.test(row["membershipId"]) &&
    typeof row["id"] === "string" &&
    UUID_PATTERN.test(row["id"]) &&
    typeof row["createdAt"] === "string" &&
    Number.isFinite(Date.parse(row["createdAt"])) &&
    typeof row["state"] === "string" &&
    STATES.has(row["state"] as NotificationState)
  );
}

function safeActionPath(value: string | null): string | null {
  return value?.startsWith("/partners/") ? value : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "portal.session.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { accountId, membershipId } = principal;
  if (!accountId || !membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (!arePartnerPortalV2ReadsEnabled(accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const accessScopeKey = partnerJobAccessScopeKey(principal);
  const stateValues = request.nextUrl.searchParams.getAll("state");
  const state = (stateValues[0] ?? "all") as NotificationState;
  if (stateValues.length > 1 || !STATES.has(state)) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const pagination = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: "partner_notifications",
    validateCursorPayload: isNotificationCursor,
    defaultLimit: 25,
    maximumLimit: 100,
    allowedQueryKeys: new Set(["state"]),
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
    (pagination.cursor.payload.accountId !== accountId ||
      pagination.cursor.payload.membershipId !== membershipId ||
      pagination.cursor.payload.state !== state ||
      pagination.cursor.payload.accessScopeKey !== accessScopeKey)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_cursor",
      422,
      correlationId,
    );
  }
  try {
    const cursorAt = pagination.cursor
      ? new Date(pagination.cursor.payload.createdAt)
      : null;
    const cursorId = pagination.cursor?.payload.id ?? null;
    const rows = await getDb()
      .select({
        id: partnerNotifications.id,
        jobId: partnerNotifications.partnerBookingId,
        eventKey: partnerNotifications.eventKey,
        title: partnerNotifications.title,
        body: partnerNotifications.body,
        actionPath: partnerNotifications.actionPath,
        readAt: partnerNotifications.readAt,
        createdAt: partnerNotifications.createdAt,
      })
      .from(partnerNotifications)
      .leftJoin(
        partnerBookings,
        and(
          eq(partnerBookings.id, partnerNotifications.partnerBookingId),
          eq(
            partnerBookings.partnerAccountId,
            partnerNotifications.partnerAccountId,
          ),
        ),
      )
      .leftJoin(
        partnerAccountLocations,
        createPartnerJobLocationJoinCondition(),
      )
      .where(
        and(
          createPartnerNotificationAccessCondition(principal),
          eq(partnerNotifications.membershipId, membershipId),
          state === "unread"
            ? isNull(partnerNotifications.readAt)
            : state === "read"
              ? isNotNull(partnerNotifications.readAt)
              : undefined,
          cursorAt && cursorId
            ? or(
                lt(partnerNotifications.createdAt, cursorAt),
                and(
                  eq(partnerNotifications.createdAt, cursorAt),
                  lt(partnerNotifications.id, cursorId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(partnerNotifications.createdAt),
        desc(partnerNotifications.id),
      )
      .limit(pagination.limit + 1);
    const hasMore = rows.length > pagination.limit;
    const pageRows = hasMore ? rows.slice(0, pagination.limit) : rows;
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePortalV2Cursor({
            kind: "partner_notifications",
            limit: pagination.limit,
            payload: {
              accessScopeKey,
              accountId,
              membershipId,
              state,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            } satisfies NotificationCursor,
          })
        : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        notifications: pageRows.map((notification) => ({
          id: notification.id,
          jobId: notification.jobId,
          eventKey: notification.eventKey,
          title: notification.title,
          body: notification.body,
          actionPath: safeActionPath(notification.actionPath),
          readAt: notification.readAt?.toISOString() ?? null,
          createdAt: notification.createdAt.toISOString(),
        })),
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
