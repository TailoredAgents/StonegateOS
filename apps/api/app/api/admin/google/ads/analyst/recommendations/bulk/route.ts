import type { NextRequest } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  googleAdsAnalystRecommendationEvents,
  googleAdsAnalystRecommendations,
} from "@/db";
import { assertGoogleAdsReviewTransition } from "@/lib/google-ads-recommendation-operations";
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

const BulkUpdateSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        expectedVersion: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(200),
  status: z.enum(["proposed", "approved", "ignored"]),
  confirmation: z.enum(["reset", "approve", "ignore"]),
  note: z.string().trim().max(800).optional(),
});

function nextTimestamp(previous: Date, candidate = new Date()): Date {
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}

function expectedConfirmation(status: "proposed" | "approved" | "ignored") {
  return status === "approved"
    ? "approve"
    : status === "ignored"
      ? "ignore"
      : "reset";
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "marketing.google_ads_recommendations.bulk_update",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsed = BulkUpdateSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The selected recommendation decisions are invalid.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { recommendations: "Refresh and select the items again." },
      },
    );
  }
  const uniqueIds = new Set(parsed.data.items.map((item) => item.id));
  if (uniqueIds.size !== parsed.data.items.length) {
    return teamMutationErrorResponse(
      "invalid",
      "Each recommendation may be selected only once.",
      { correlationId: mutation.correlationId },
    );
  }
  if (parsed.data.confirmation !== expectedConfirmation(parsed.data.status)) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm the exact bulk decision before saving it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Review and confirm the bulk decision." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const orderedItems = [...parsed.data.items].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/google/ads/analyst/recommendations/bulk",
      entityType: "google_ads_analyst_recommendation_batch",
      entityId: `count:${orderedItems.length}`,
      payload: { ...parsed.data, items: orderedItems },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: googleAdsAnalystRecommendations.id,
          reportId: googleAdsAnalystRecommendations.reportId,
          kind: googleAdsAnalystRecommendations.kind,
          status: googleAdsAnalystRecommendations.status,
          updatedAt: googleAdsAnalystRecommendations.updatedAt,
        })
        .from(googleAdsAnalystRecommendations)
        .where(
          inArray(
            googleAdsAnalystRecommendations.id,
            orderedItems.map((item) => item.id),
          ),
        )
        .orderBy(asc(googleAdsAnalystRecommendations.id))
        .for("update");
      if (rows.length !== orderedItems.length) {
        throw new TeamMutationFailure(
          "invalid",
          "One or more selected recommendations no longer exist.",
          { status: 404 },
        );
      }

      const requestById = new Map(
        orderedItems.map((item) => [item.id, item.expectedVersion]),
      );
      for (const row of rows) {
        if (row.updatedAt.toISOString() !== requestById.get(row.id)) {
          throw new TeamMutationFailure(
            "conflict",
            "A selected recommendation changed after it was loaded. No decisions were saved.",
            { fieldErrors: { version: "Refresh the recommendation list." } },
          );
        }
        assertGoogleAdsReviewTransition(row.status, parsed.data.status);
      }

      const now = new Date();
      const updatedItems: Array<{ id: string; version: string }> = [];
      for (const row of rows) {
        const nextVersion = nextTimestamp(row.updatedAt, now);
        const [updated] = await tx
          .update(googleAdsAnalystRecommendations)
          .set({
            status: parsed.data.status,
            decidedBy:
              parsed.data.status === "proposed"
                ? null
                : (mutation.actor.id ?? null),
            decidedAt: parsed.data.status === "proposed" ? null : now,
            appliedAt: null,
            updatedAt: nextVersion,
          })
          .where(
            and(
              eq(googleAdsAnalystRecommendations.id, row.id),
              eq(googleAdsAnalystRecommendations.status, row.status),
              eq(googleAdsAnalystRecommendations.updatedAt, row.updatedAt),
            ),
          )
          .returning({ id: googleAdsAnalystRecommendations.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "A recommendation changed while the bulk decision was being saved. No decisions were saved.",
            { retryable: true },
          );
        }
        updatedItems.push({ id: row.id, version: nextVersion.toISOString() });
      }

      await tx.insert(googleAdsAnalystRecommendationEvents).values(
        rows.map((row) => ({
          recommendationId: row.id,
          reportId: row.reportId,
          kind: row.kind,
          fromStatus: row.status,
          toStatus: parsed.data.status,
          note: parsed.data.note ?? null,
          actorMemberId: mutation.actor.id ?? null,
          actorSource: "ui",
          createdAt: now,
        })),
      );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "google_ads_analyst_recommendation_batch",
        entityId: claimed.claim.id,
        before: {
          items: rows.map((row) => ({
            id: row.id,
            status: row.status,
            version: row.updatedAt.toISOString(),
          })),
        },
        after: { status: parsed.data.status, items: updatedItems },
        metadata: {
          count: rows.length,
          surface: "team.marketing.ads",
        },
        committedAt: now,
      });
      const response = teamMutationSuccessResult(
        mutation,
        {
          status: parsed.data.status,
          updated: updatedItems.length,
          items: updatedItems,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "google_ads_analyst_recommendation_batch",
          entityId: claimed.claim.id,
          version: now.toISOString(),
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
        console.error(
          "[google-ads] bulk_review_idempotency_settlement_failed",
          {
            operationId: mutation.operationId,
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
