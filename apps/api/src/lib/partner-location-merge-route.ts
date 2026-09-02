import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, partnerAccountLocations } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  mergeDuplicatePartnerLocation,
  restoreMergedPartnerLocation,
} from "@/lib/partner-location-merge";
import {
  partnerLocationDirectoryEtag,
} from "@/lib/partner-location-portfolio";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerLocationDto,
  partnerLocationRevision,
  PartnerLocationMergeSchema,
  PartnerLocationUnmergeSchema,
} from "@/lib/partner-portal-v2-locations";
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

type Mode = "merge" | "restore";

export async function handlePartnerLocationMergeMutation(
  request: NextRequest,
  input: Readonly<{ locationId: string; mode: Mode }>,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isPortalV2Uuid(input.locationId)) {
    return createPartnerPortalV2ErrorResponse(
      "not_found",
      404,
      correlationId,
    );
  }
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "properties.manage",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    principal.accessLevel !== "account"
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
      maximumBytes: 4 * 1_024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed =
    input.mode === "merge"
      ? PartnerLocationMergeSchema.safeParse(raw)
      : PartnerLocationUnmergeSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const [current] = await getDb()
      .select()
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, principal.accountId),
          eq(partnerAccountLocations.id, input.locationId),
        ),
      )
      .limit(1);
    if (!current) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: request.headers.get("if-match"),
      currentRevision: partnerLocationRevision(current),
      correlationId,
    });
    if (!precondition.ok) {
      return createPartnerPortalV2DescriptorResponse(precondition.response);
    }
    const mutation = await runPortalV2IdempotentMutation({
      principal: `${principal.partnerUserId}:${principal.accountId}`,
      action:
        input.mode === "merge"
          ? "partner_location.merge"
          : "partner_location.merge_restore",
      keyHash: idempotency.keyHash!,
      scope: `${principal.accountId}:${input.locationId}`,
      payload: parsed.data,
      correlationId,
      execute: async () => {
        const result = await getDb().transaction((tx) =>
          input.mode === "merge"
            ? mergeDuplicatePartnerLocation(tx, {
                principal,
                sourceLocationId: input.locationId,
                targetLocationId: (parsed.data as { targetLocationId: string })
                  .targetLocationId,
                expectedVersion: current.version,
                reason: parsed.data.reason,
                correlationId,
                idempotencyKeyHash: idempotency.keyHash!,
              })
            : restoreMergedPartnerLocation(tx, {
                principal,
                locationId: input.locationId,
                expectedVersion: current.version,
                reason: parsed.data.reason,
                correlationId,
                idempotencyKeyHash: idempotency.keyHash!,
              }),
        );
        if (result.kind === "not_found") {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        if (result.kind === "revision_mismatch") {
          return {
            status: 412,
            body: { ok: false, error: "revision_mismatch" },
          };
        }
        if (result.kind === "not_duplicate") {
          return {
            status: 422,
            body: { ok: false, error: "invalid_fields" },
          };
        }
        if (result.kind === "references_require_resolution") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        if (result.kind === "invalid_state") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        if (result.kind !== "success") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        const location = createPartnerLocationDto(result.row, {
          defaultLocationId: result.defaultLocationId,
          favoriteLocationIds: new Set(),
          childCount: 0,
          directoryVersion: result.directoryVersion,
          includeHierarchy: true,
        });
        return {
          status: 200,
          body: {
            ok: true,
            location,
            mode: input.mode,
            duplicateConfidence: result.duplicateConfidence,
          },
          headers: {
            ETag: location.etag,
            "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
              accountId: principal.accountId!,
              version: result.directoryVersion,
            }),
          },
        };
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
    console.error("[partner-portal-v2] location merge mutation failed", {
      correlationId,
      accountId: principal.accountId,
      locationId: input.locationId,
      mode: input.mode,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
