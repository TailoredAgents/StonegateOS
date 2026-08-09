import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { maybeGenerateSeoDraft } from "@/lib/seo/agent";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const RunSchema = z.object({
  force: z.boolean().optional(),
});

type SeoRunData =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      postId: string;
      slug: string;
      title: string;
      editorialStatus: "draft" | "review" | "published" | "failed";
      publicationEffect: "none";
    };

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.publish"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "seo.draft.generated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsed = RunSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The SEO draft request is invalid.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { request: "Refresh the page and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/seo/run",
      entityType: "seo_draft_generation",
      entityId: "new",
      payload: { scheduleLimitsEnforced: true },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await maybeGenerateSeoDraft({
      // A human "Run now" performs the scheduled check immediately; it never
      // bypasses generation limits.
      force: false,
      invokedBy: `team:${mutation.actor.id ?? "unknown"}`,
      generationKeyHash: mutation.idempotencyKeyHash,
      mutation,
    });
    if (!result.ok) {
      throw new TeamMutationFailure(
        "provider_failed",
        "The SEO provider could not create a draft. Nothing was published.",
        { retryable: true },
      );
    }

    const mutationResult = await db.transaction(async (tx) => {
      if (result.skipped) {
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "seo_agent",
          entityId: null,
          before: null,
          after: { skipped: true, reason: result.reason },
          metadata: { publicationEffect: "none" },
        });
        const response = teamMutationSuccessResult<SeoRunData>(
          mutation,
          { skipped: true as const, reason: result.reason },
          {
            auditEventId: audit.auditEventId,
            committedAt: audit.committedAt,
            entityType: "seo_agent",
          },
        );
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          response,
          200,
        );
        return response;
      }

      const response = teamMutationSuccessResult<SeoRunData>(
        mutation,
        {
          skipped: false as const,
          postId: result.postId,
          slug: result.slug,
          title: result.title,
          editorialStatus: result.editorialStatus,
          publicationEffect: "none" as const,
        },
        {
          auditEventId: result.auditEventId,
          committedAt: result.committedAt,
          entityType: "blog_post",
          entityId: result.postId,
          version: "1",
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
      );
      return response;
    });

    return teamMutationResultResponse(
      mutationResult,
      200,
      mutation.correlationId,
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[seo] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
