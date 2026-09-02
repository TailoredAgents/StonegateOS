import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { decidePartnerLocationAddressReview } from "@/lib/partner-location-address-review-administration";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DecisionSchema = z
  .object({
    decision: z.enum(["verified", "correction_required", "dismissed"]),
    note: z.string().trim().min(12).max(1_000),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    serviceAreaEligible: z.boolean().optional(),
    confirmation: z.enum([
      "VERIFY LOCATION",
      "REQUEST ADDRESS CORRECTION",
      "DISMISS ADDRESS REVIEW",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.decision === "verified"
        ? "VERIFY LOCATION"
        : value.decision === "correction_required"
          ? "REQUEST ADDRESS CORRECTION"
          : "DISMISS ADDRESS REVIEW";
    if (value.confirmation !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expected} exactly.`,
      });
    }
    if (
      value.decision === "verified" &&
      (value.latitude === undefined ||
        value.longitude === undefined ||
        value.serviceAreaEligible === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latitude"],
        message:
          "Verified latitude, longitude, and service-area eligibility are required.",
      });
    }
    if (
      value.decision !== "verified" &&
      (value.latitude !== undefined ||
        value.longitude !== undefined ||
        value.serviceAreaEligible !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latitude"],
        message: "Coordinates apply only to a verified decision.",
      });
    }
  });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ reviewId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_location_address_review.decided",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const reviewId =
    (await context.params).reviewId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(reviewId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid address review.",
      { status: 404, correlationId: mutation.correlationId },
    );
  }
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest address-review revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh Address reviews." },
      },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded decision, supporting evidence, and exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          note: "Explain the decision in 12–1000 characters.",
          coordinates:
            "Verification requires valid coordinates and a service-area decision.",
          confirmation: "Type the confirmation shown for the decision exactly.",
        },
      },
    );
  }
  const actorId = mutation.actor.id;
  if (!actorId || !UUID_PATTERN.test(actorId)) {
    return teamMutationErrorResponse(
      "forbidden",
      "A verified Team member is required.",
      { correlationId: mutation.correlationId },
    );
  }

  const database = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route:
        "POST /api/admin/partner-management/v1/location-reviews/:reviewId/decision",
      entityType: "partner_location_address_review",
      entityId: reviewId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await database.transaction(async (tx) => {
      const decided = await decidePartnerLocationAddressReview(tx, {
        reviewId,
        decision: parsed.data.decision,
        note: parsed.data.note,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        serviceAreaEligible: parsed.data.serviceAreaEligible,
        teamMemberId: actorId,
        expectedVersion: mutation.expectedVersion!,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_location_address_review",
        entityId: reviewId,
        before: decided.before,
        after: decided.after,
        metadata: {
          partnerAccountId: decided.partnerAccountId,
          locationId: decided.locationId,
          decision: parsed.data.decision,
          note: parsed.data.note,
          coordinatesRecorded: parsed.data.decision === "verified",
          serviceAreaEligible:
            parsed.data.decision === "verified"
              ? parsed.data.serviceAreaEligible
              : null,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          reviewId,
          partnerAccountId: decided.partnerAccountId,
          locationId: decided.locationId,
          state: decided.review.state,
          locationVersion: decided.locationVersion,
          version: String(decided.review.version),
          resolvedAt: decided.review.resolvedAt?.toISOString() ?? null,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_location_address_review",
          entityId: reviewId,
          version: String(decided.review.version),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          database,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error(
          "[partner-management] location_review_settlement_failed",
          {
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
