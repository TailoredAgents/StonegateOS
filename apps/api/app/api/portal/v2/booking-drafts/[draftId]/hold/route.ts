import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createOrReplacePartnerHold,
  getPartnerBookingDraft,
  PartnerPortalSchedulingError,
  releasePartnerHold,
  requirePartnerArrivalWindowId,
  requirePartnerSchedulingActor,
  requirePortalUuid,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorize(request: NextRequest, correlationId: string) {
  const createAuthorization = await requirePartnerCapability(
    request,
    "bookings.create",
  );
  if (createAuthorization.ok) {
    return {
      authorization: createAuthorization,
      capability: "create" as const,
    };
  }
  const updateAuthorization = await requirePartnerCapability(
    request,
    "bookings.update",
  );
  if (updateAuthorization.ok) {
    return {
      authorization: updateAuthorization,
      capability: "update" as const,
    };
  }
  return portalAuthorizationFailureResponse(createAuthorization, correlationId);
}

async function requireRescheduleDraftForUpdateOnly(input: {
  actor: ReturnType<typeof requirePartnerSchedulingActor>;
  draftId: string;
  capability: "create" | "update";
}): Promise<void> {
  if (input.capability === "create") return;
  const draft = await getPartnerBookingDraft({
    actor: input.actor,
    draftId: input.draftId,
  });
  if (!draft.rescheduleFromJobId) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The schedule-change draft was not found.",
      { status: 404 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const access = await authorize(request, correlationId);
    if (access instanceof Response) return access;
    const actor = requirePartnerSchedulingActor(
      access.authorization.principal,
      "write",
    );
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) {
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    }
    if (!idempotency.keyHash) {
      throw new TypeError("Required Idempotency-Key did not produce a hash.");
    }
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "windowId")
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "An arrival window is required.",
        { status: 400 },
      );
    }
    const windowId = requirePartnerArrivalWindowId(body["windowId"]);
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    await requireRescheduleDraftForUpdateOnly({
      actor,
      draftId,
      capability: access.capability,
    });
    const result = await createOrReplacePartnerHold({
      actor,
      draftId,
      windowId,
      idempotencyKeyHash: idempotency.keyHash,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, hold: result.hold, replayed: result.replayed },
      correlationId,
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const access = await authorize(request, correlationId);
    if (access instanceof Response) return access;
    const actor = requirePartnerSchedulingActor(
      access.authorization.principal,
      "write",
    );
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    await requireRescheduleDraftForUpdateOnly({
      actor,
      draftId,
      capability: access.capability,
    });
    const rawHoldId = request.nextUrl.searchParams.get("holdId");
    const holdId = rawHoldId ? requirePortalUuid(rawHoldId, "holdId") : null;
    const result = await releasePartnerHold({ actor, draftId, holdId });
    return portalSchedulingSuccessResponse(
      { ok: true, released: result.released },
      correlationId,
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
