import type { NextRequest } from "next/server";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
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
const PublishSchema = z.object({ confirmation: z.string().trim().min(1).max(220) });
const DAY_MS = 24 * 60 * 60 * 1_000;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.publish"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "seo.post.published",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { postId: rawPostId } = await context.params;
  const postId = rawPostId?.trim() ?? "";
  if (!UUID_PATTERN.test(postId)) {
    return teamMutationErrorResponse("invalid", "Select a valid SEO post.", {
      correlationId: mutation.correlationId,
      fieldErrors: { postId: "Refresh the SEO workspace." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest review version is required before publishing.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the post and try again." },
      },
    );
  }

  const parsed = PublishSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Type the post slug to confirm publication.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "The exact slug is required." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/seo/posts/:postId/publish",
      entityType: "blog_post",
      entityId: postId,
      payload: { confirmation: parsed.data.confirmation },
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
        throw new TeamMutationFailure("invalid", "The SEO post was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, existing.version);
      if (parsed.data.confirmation !== existing.slug) {
        throw new TeamMutationFailure(
          "invalid",
          "The publication confirmation does not match this post.",
          { fieldErrors: { confirmation: `Type ${existing.slug} exactly.` } },
        );
      }
      if (existing.editorialStatus !== "review" || existing.publishedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "Only an unpublished post in Review can be published.",
        );
      }
      const actorId = mutation.actor.id;
      if (!actorId) {
        throw new TeamMutationFailure(
          "internal",
          "The verified publishing actor is incomplete.",
        );
      }

      const now = new Date();
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      const recentPublished = await tx
        .select({ publishedAt: blogPosts.publishedAt })
        .from(blogPosts)
        .where(
          and(
            isNotNull(blogPosts.publishedAt),
            gte(blogPosts.publishedAt, since7d),
            lte(blogPosts.publishedAt, now),
          ),
        )
        .orderBy(desc(blogPosts.publishedAt));
      if (recentPublished.length >= 2) {
        const oldest = recentPublished[recentPublished.length - 1]?.publishedAt;
        const retryAt = oldest
          ? new Date(oldest.getTime() + 7 * DAY_MS)
          : new Date(now.getTime() + DAY_MS);
        throw new TeamMutationFailure(
          "rate_limited",
          `Publishing is limited to two posts in seven days. Try again after ${retryAt.toISOString()}.`,
          {
            retryable: true,
            retryAfter: String(
              Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000)),
            ),
          },
        );
      }
      const latestPublishedAt = recentPublished[0]?.publishedAt ?? null;
      if (
        latestPublishedAt &&
        latestPublishedAt.getTime() > now.getTime() - 3 * DAY_MS
      ) {
        const retryAt = new Date(latestPublishedAt.getTime() + 3 * DAY_MS);
        throw new TeamMutationFailure(
          "rate_limited",
          `Publishing is limited to one post every three days. Try again after ${retryAt.toISOString()}.`,
          {
            retryable: true,
            retryAfter: String(
              Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000)),
            ),
          },
        );
      }
      const nextVersion = existing.version + 1;
      const [updated] = await tx
        .update(blogPosts)
        .set({
          editorialStatus: "published",
          reviewedAt: now,
          reviewedBy: actorId,
          publishedAt: now,
          publishedBy: actorId,
          lastError: null,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(blogPosts.id, postId),
            eq(blogPosts.version, existing.version),
            eq(blogPosts.editorialStatus, "review"),
          ),
        )
        .returning({ id: blogPosts.id });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The post changed while it was being published. Refresh and try again.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "blog_post",
        entityId: postId,
        before: {
          editorialStatus: existing.editorialStatus,
          publishedAt: null,
          version: existing.version,
        },
        after: {
          editorialStatus: "published",
          publishedAt: now.toISOString(),
          version: nextVersion,
        },
        metadata: {
          slug: existing.slug,
          title: existing.title,
          publicPath: `/blog/${existing.slug}`,
        },
        committedAt: now,
      });
      const response = teamMutationSuccessResult(
        mutation,
        {
          postId,
          slug: existing.slug,
          editorialStatus: "published" as const,
          version: nextVersion,
          publishedAt: now.toISOString(),
          publicPath: `/blog/${existing.slug}`,
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
        console.error("[seo] publish_idempotency_settlement_failed", {
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
