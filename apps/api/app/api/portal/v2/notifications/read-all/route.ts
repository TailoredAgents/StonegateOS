import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
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

export async function POST(request: NextRequest): Promise<Response> {
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
  if (!accountId || !membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
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
      action: "partner.notifications.read_all",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/notifications/read-all:${membershipId}:${partnerJobAccessScopeKey(principal)}`,
      payload: {},
      correlationId,
      execute: async (): Promise<PortalV2StoredResult> => {
        const readAt = new Date();
        const markedRead = await getDb().transaction(async (tx) => {
          const visible = await tx
            .select({ id: partnerNotifications.id })
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
                isNull(partnerNotifications.readAt),
              ),
            )
            .for("update", { of: partnerNotifications });
          let count = 0;
          for (let index = 0; index < visible.length; index += 500) {
            const ids = visible.slice(index, index + 500).map((row) => row.id);
            if (ids.length === 0) continue;
            const updated = await tx
              .update(partnerNotifications)
              .set({ readAt })
              .where(
                and(
                  inArray(partnerNotifications.id, ids),
                  eq(partnerNotifications.partnerAccountId, accountId),
                  eq(partnerNotifications.membershipId, membershipId),
                  isNull(partnerNotifications.readAt),
                ),
              )
              .returning({ id: partnerNotifications.id });
            count += updated.length;
          }
          return count;
        });
        return {
          status: 200,
          body: {
            ok: true,
            markedRead,
            readAt: readAt.toISOString(),
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
