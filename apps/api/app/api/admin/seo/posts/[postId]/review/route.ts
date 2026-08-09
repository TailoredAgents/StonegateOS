import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { blogPosts, getDb } from "@/db";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ postId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.publish"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "seo.draft.submitted_for_review",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { postId: rawPostId } = await context.params;
  const postId = rawPostId?.trim() ?? "";
  if (!UUID_PATTERN.test(postId)) {
    return teamMutationErrorResponse("invalid", "Select a valid SEO draft.", {
      correlationId: mutation.correlationId,
      fieldErrors: { postId: "Refresh the SEO workspace." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest draft version is required before review.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the draft and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/seo/posts/:postId/review",
      entityType: "blog_post",
      entityId: postId,
      payload: { transition: "draft_to_review" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: blogPosts.id,
          title: blogPosts.title,
          slug: blogPosts.slug,
          editorialStatus: blogPosts.editorialStatus,
          version: blogPosts.version,
          publishedAt: blogPosts.publishedAt,
        })
        .from(blogPosts)
        .where(eq(blogPosts.id, postId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The SEO draft was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, existing.version);
      if (existing.editorialStatus !== "draft" || existing.publishedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "Only an unpublished draft can be submitted for review.",
        );
      }

      const now = new Date();
      const nextVersion = existing.version + 1;
      const [updated] = await tx
        .update(blogPosts)
        .set({
          editorialStatus: "review",
          reviewRequestedAt: now,
          reviewedAt: null,
          reviewedBy: null,
          lastError: null,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(blogPosts.id, postId),
            eq(blogPosts.version, existing.version),
            eq(blogPosts.editorialStatus, "draft"),
          ),
        )
        .returning({ id: blogPosts.id });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The draft changed while it was being submitted. Refresh and try again.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "blog_post",
        entityId: postId,
        before: {
          editorialStatus: existing.editorialStatus,
          version: existing.version,
        },
        after: {
          editorialStatus: "review",
          reviewRequestedAt: now.toISOString(),
          version: nextVersion,
        },
        metadata: {
          slug: existing.slug,
          title: existing.title,
          publicationEffect: "none",
        },
        committedAt: now,
      });
      const response = teamMutationSuccessResult(
        mutation,
        {
          postId,
          editorialStatus: "review" as const,
          version: nextVersion,
          reviewRequestedAt: now.toISOString(),
          publicationEffect: "none" as const,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "blog_post",
          entityId: postId,
          version: String(nextVersion),
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
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[seo] review_idempotency_settlement_failed", {
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
