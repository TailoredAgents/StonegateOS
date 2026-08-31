import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { removeQuoteV2Attachment } from "@/lib/quote-v2-attachment-service";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BodySchema = z
  .object({ confirmation: z.literal("remove_quote_attachment") })
  .strict();

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id?: string; attachmentId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.attachment_removed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const { id: versionId = "", attachmentId = "" } = await context.params;
  if (!UUID_PATTERN.test(versionId) || !UUID_PATTERN.test(attachmentId)) {
    return teamMutationErrorResponse(
      "invalid",
      "The attachment was not found.",
      {
        correlationId: mutation.correlationId,
        status: 404,
      },
    );
  }
  if (!isQuoteV2FeatureEnabled("staff")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The quote workspace is unavailable.",
      {
        correlationId: mutation.correlationId,
        status: 404,
      },
    );
  }
  const expectedDraftRevision = Number(mutation.expectedVersion);
  if (
    !Number.isSafeInteger(expectedDraftRevision) ||
    expectedDraftRevision <= 0
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current draft revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote draft." },
      },
    );
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return teamMutationErrorResponse("invalid", "Confirm attachment removal.", {
      correlationId: mutation.correlationId,
      fieldErrors: { confirmation: "Confirm removal from this draft." },
    });
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId) {
    return teamMutationErrorResponse(
      "internal",
      "The team member could not be resolved.",
      {
        correlationId: mutation.correlationId,
      },
    );
  }
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/quote-versions/:id/attachments/:attachmentId",
      entityType: "quote_version_attachment",
      entityId: attachmentId,
      payload: { versionId, attachmentId, ...parsed.data },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await removeQuoteV2Attachment(tx, {
        versionId,
        attachmentId,
        expectedDraftRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_version_attachment",
        entityId: attachmentId,
        before: { versionId, attachmentId },
        after: { removed: true },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_version_attachment",
        entityId: attachmentId,
        version: String(receipt.draftRevision),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_version_attachment",
      entityId: attachmentId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { versionId, phase: "v2_attachment_remove" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
