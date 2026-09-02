import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerLocationFavorites,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { auditPartnerLocationPortfolio } from "@/lib/partner-location-portfolio";
import {
  createPartnerLocationDto,
  partnerLocationRevision,
  PartnerLocationFavoriteSchema,
} from "@/lib/partner-portal-v2-locations";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { createPartnerLocationAccessCondition } from "@/lib/partner-portal-v2-resource-authorization";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ locationId: string }> };

export async function PUT(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "properties.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { locationId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(locationId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
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
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 256,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerLocationFavoriteSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const mutation = await runPortalV2IdempotentMutation({
      principal: `${principal.partnerUserId}:${principal.membershipId}`,
      action: "partner_location.favorite",
      keyHash: idempotency.keyHash!,
      scope: `${principal.accountId}:${locationId}`,
      payload: parsed.data,
      correlationId,
      execute: async () => {
        const db = getDb();
        return db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(partnerAccountLocations)
            .where(createPartnerLocationAccessCondition(principal, locationId))
            .for("update")
            .limit(1);
          if (!row) {
            return { status: 404, body: { ok: false, error: "not_found" } };
          }
          const precondition = evaluatePortalV2RevisionPrecondition({
            ifMatch: request.headers.get("if-match"),
            currentRevision: partnerLocationRevision(row),
            correlationId,
          });
          if (!precondition.ok) {
            return {
              status: precondition.response.status,
              body: precondition.response.body,
              headers: precondition.response.headers,
            };
          }
          if (parsed.data.favorite) {
            await tx
              .insert(partnerLocationFavorites)
              .values({
                partnerAccountId: principal.accountId!,
                membershipId: principal.membershipId!,
                locationId: row.id,
              })
              .onConflictDoNothing();
          } else {
            await tx
              .delete(partnerLocationFavorites)
              .where(
                and(
                  eq(
                    partnerLocationFavorites.partnerAccountId,
                    principal.accountId!,
                  ),
                  eq(
                    partnerLocationFavorites.membershipId,
                    principal.membershipId!,
                  ),
                  eq(partnerLocationFavorites.locationId, row.id),
                ),
              );
          }
          const [portfolio] = await tx
            .select({
              defaultLocationId: partnerAccounts.defaultPartnerLocationId,
              directoryVersion: partnerAccounts.locationDirectoryVersion,
              childCount: sql<number>`(
                SELECT count(*)::integer
                FROM partner_account_locations child
                WHERE child.partner_account_id = ${principal.accountId}
                  AND child.parent_location_id = ${row.id}
                  AND child.active IS TRUE
              )`,
            })
            .from(partnerAccounts)
            .where(eq(partnerAccounts.id, principal.accountId!))
            .limit(1);
          if (!portfolio) throw new Error("partner_location_account_missing");
          await auditPartnerLocationPortfolio(tx, {
            principal,
            correlationId,
            action: parsed.data.favorite
              ? "partner.location.favorited"
              : "partner.location.unfavorited",
            entityType: "partner_account_location",
            entityId: row.id,
            idempotencyKeyHash: idempotency.keyHash,
            requiredPermission: "properties.read",
            meta: {
              partnerAccountId: principal.accountId,
              membershipId: principal.membershipId,
              favorite: parsed.data.favorite,
            },
          });
          const location = createPartnerLocationDto(row, {
            defaultLocationId: portfolio.defaultLocationId,
            favoriteLocationIds: parsed.data.favorite
              ? new Set([row.id])
              : new Set(),
            childCount: portfolio.childCount,
            directoryVersion: portfolio.directoryVersion,
          });
          return {
            status: 200,
            body: { ok: true, location },
            headers: { ETag: location.etag },
          };
        });
      },
    });
    if (mutation.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(mutation.result, correlationId);
  } catch (error) {
    console.error("[partner-portal-v2] location favorite failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
