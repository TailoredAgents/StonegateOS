import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerBookings,
  partnerNotifications,
} from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerJobLocationJoinCondition,
  createPartnerNotificationAccessCondition,
  partnerJobAccessScopeKey,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  runPortalV2IdempotentMutation,
  type PortalV2StoredResult,
} from "@/lib/partner-portal-v2-idempotency";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ notificationId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
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
  const { notificationId } = await context.params;
  if (!accountId || !membershipId || !UUID_PATTERN.test(notificationId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  try {
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${authorization.principal.partnerUserId}`,
      action: "partner.notification.read",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/notifications/${notificationId}/read:${membershipId}:${partnerJobAccessScopeKey(principal)}`,
      payload: { notificationId },
      correlationId,
      execute: async (): Promise<PortalV2StoredResult> => {
        const db = getDb();
        const [existing] = await db
          .select({
            id: partnerNotifications.id,
            readAt: partnerNotifications.readAt,
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
              eq(partnerNotifications.id, notificationId),
              createPartnerNotificationAccessCondition(principal),
              eq(partnerNotifications.membershipId, membershipId),
            ),
          )
          .limit(1);
        if (!existing) {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        const readAt = existing.readAt ?? new Date();
        if (!existing.readAt) {
          await db
            .update(partnerNotifications)
            .set({ readAt })
            .where(
              and(
                eq(partnerNotifications.id, notificationId),
                eq(partnerNotifications.partnerAccountId, accountId),
                eq(partnerNotifications.membershipId, membershipId),
              ),
            );
        }
        return {
          status: 200,
          body: {
            ok: true,
            notification: { id: notificationId, readAt: readAt.toISOString() },
          },
        };
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(
          run.reason === "different_request"
            ? "idempotency_conflict"
            : "conflict",
          correlationId,
        ),
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
