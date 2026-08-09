import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  googleAdsAnalystRecommendationEvents,
  googleAdsAnalystRecommendations,
  googleAdsAnalystReports,
} from "@/db";
import {
  assertGoogleAdsReviewTransition,
  buildGoogleAdsRecommendationChange,
  latestGoogleAdsOperationsForRecommendations,
} from "@/lib/google-ads-recommendation-operations";
import { requirePermission } from "@/lib/permissions";
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
import { isAdminRequest } from "../../../../../web/admin";

const UpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["proposed", "approved", "ignored"]),
  confirmation: z.enum(["reset", "approve", "ignore"]),
  note: z.string().trim().max(800).optional(),
});

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

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

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "marketing.read");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const reportIdParam = asString(url.searchParams.get("reportId"));

  const db = getDb();
  const reportId =
    reportIdParam ??
    (await db
      .select({ id: googleAdsAnalystReports.id })
      .from(googleAdsAnalystReports)
      .orderBy(desc(googleAdsAnalystReports.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null));

  if (!reportId) {
    return NextResponse.json({ ok: true, reportId: null, items: [] });
  }

  const items = await db
    .select({
      id: googleAdsAnalystRecommendations.id,
      kind: googleAdsAnalystRecommendations.kind,
      status: googleAdsAnalystRecommendations.status,
      payload: googleAdsAnalystRecommendations.payload,
      decidedBy: googleAdsAnalystRecommendations.decidedBy,
      decidedAt: googleAdsAnalystRecommendations.decidedAt,
      appliedAt: googleAdsAnalystRecommendations.appliedAt,
      createdAt: googleAdsAnalystRecommendations.createdAt,
      updatedAt: googleAdsAnalystRecommendations.updatedAt,
    })
    .from(googleAdsAnalystRecommendations)
    .where(eq(googleAdsAnalystRecommendations.reportId, reportId))
    .orderBy(desc(googleAdsAnalystRecommendations.createdAt))
    .limit(200);
  const latestOperations = await latestGoogleAdsOperationsForRecommendations(
    db,
    items.map((item) => item.id),
  );

  return NextResponse.json({
    ok: true,
    reportId,
    items: items.map((row) => ({
      ...row,
      version: row.updatedAt.toISOString(),
      change: buildGoogleAdsRecommendationChange(row.kind, row.payload),
      lastAction: latestOperations.get(row.id) ?? null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "marketing.google_ads_recommendation.update",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest recommendation version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the recommendation and try again." },
      },
    );
  }

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The recommendation review request is invalid.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { recommendation: "Refresh and review the item again." },
      },
    );
  }
  if (parsed.data.confirmation !== expectedConfirmation(parsed.data.status)) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm the exact recommendation decision before saving it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Review the decision and confirm it." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/google/ads/analyst/recommendations",
      entityType: "google_ads_analyst_recommendation",
      entityId: parsed.data.id,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: googleAdsAnalystRecommendations.id,
          reportId: googleAdsAnalystRecommendations.reportId,
          kind: googleAdsAnalystRecommendations.kind,
          status: googleAdsAnalystRecommendations.status,
          updatedAt: googleAdsAnalystRecommendations.updatedAt,
        })
        .from(googleAdsAnalystRecommendations)
        .where(eq(googleAdsAnalystRecommendations.id, parsed.data.id))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure(
          "invalid",
          "The Google Ads recommendation was not found.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      assertGoogleAdsReviewTransition(existing.status, parsed.data.status);

      const now = new Date();
      const nextVersion = nextTimestamp(existing.updatedAt, now);
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
            eq(googleAdsAnalystRecommendations.id, existing.id),
            eq(googleAdsAnalystRecommendations.status, existing.status),
            eq(googleAdsAnalystRecommendations.updatedAt, existing.updatedAt),
          ),
        )
        .returning({ id: googleAdsAnalystRecommendations.id });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The recommendation changed while the decision was being saved.",
          { retryable: true },
        );
      }

      await tx.insert(googleAdsAnalystRecommendationEvents).values({
        recommendationId: existing.id,
        reportId: existing.reportId,
        kind: existing.kind,
        fromStatus: existing.status,
        toStatus: parsed.data.status,
        note: parsed.data.note ?? null,
        actorMemberId: mutation.actor.id ?? null,
        actorSource: "ui",
        createdAt: now,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "google_ads_analyst_recommendation",
        entityId: existing.id,
        before: {
          status: existing.status,
          version: existing.updatedAt.toISOString(),
        },
        after: {
          status: parsed.data.status,
          version: nextVersion.toISOString(),
        },
        metadata: { kind: existing.kind, surface: "team.marketing.ads" },
        committedAt: now,
      });
      const response = teamMutationSuccessResult(
        mutation,
        {
          id: existing.id,
          status: parsed.data.status,
          version: nextVersion.toISOString(),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "google_ads_analyst_recommendation",
          entityId: existing.id,
          version: nextVersion.toISOString(),
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
        console.error("[google-ads] review_idempotency_settlement_failed", {
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
