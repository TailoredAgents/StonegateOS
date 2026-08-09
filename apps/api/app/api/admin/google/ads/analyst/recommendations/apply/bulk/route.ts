import { createHash } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  claimGoogleAdsOperationDispatch,
  classifyGoogleAdsProviderMutationFailure,
  finalizeGoogleAdsOperation,
  finalizedGoogleAdsOperationFromPrepared,
  prepareGoogleAdsRecommendationOperations,
  type FinalizedGoogleAdsOperation,
  type PreparedGoogleAdsOperation,
} from "@/lib/google-ads-recommendation-operations";
import {
  applyCustomerNegativeKeyword,
  getGoogleAdsAccessToken,
  getGoogleAdsConfiguredIds,
} from "@/lib/google-ads-insights";
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
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const BulkApplySchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        expectedVersion: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(25),
  confirmation: z.literal("apply_google_ads_changes"),
});

async function googleAdsAccess(): Promise<{
  accessToken: string;
  customerId: string;
}> {
  const { customerId } = getGoogleAdsConfiguredIds();
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"]?.trim();
  if (!customerId || !developerToken) {
    throw new TeamMutationFailure(
      "invalid",
      "Google Ads is not configured. No advertising changes were attempted.",
    );
  }
  try {
    return { customerId, accessToken: await getGoogleAdsAccessToken() };
  } catch {
    throw new TeamMutationFailure(
      "provider_failed",
      "Google Ads authentication failed before dispatch. No advertising changes were attempted.",
      { retryable: true },
    );
  }
}

async function executePreparedOperation(input: {
  db: ReturnType<typeof getDb>;
  mutation: TeamMutationContext;
  prepared: PreparedGoogleAdsOperation;
  customerId: string;
  accessToken: string;
}): Promise<FinalizedGoogleAdsOperation> {
  const dispatch = await claimGoogleAdsOperationDispatch(
    input.db,
    input.mutation,
    input.prepared,
  );
  if (dispatch.kind === "terminal") {
    return finalizedGoogleAdsOperationFromPrepared(dispatch.prepared);
  }
  if (dispatch.kind === "uncertain") {
    return finalizeGoogleAdsOperation(
      input.db,
      input.mutation,
      dispatch.prepared,
      {
        state: "reconciliation_required",
        providerOperationId: null,
        providerStatus: null,
        failureCode: "google_ads_dispatched_attempt_interrupted",
        failureDetail:
          "A previous bulk request stopped after this provider dispatch boundary. The change was not sent again and requires reconciliation.",
      },
    );
  }

  let providerOutcome: Parameters<typeof finalizeGoogleAdsOperation>[3];
  try {
    const result = await applyCustomerNegativeKeyword({
      customerId: input.customerId,
      accessToken: input.accessToken,
      term: dispatch.prepared.operation.term,
    });
    providerOutcome = {
      state: "succeeded",
      providerOperationId: result.resourceName,
      providerStatus: result.providerStatus,
      failureCode: null,
      failureDetail: null,
    };
  } catch (providerError) {
    providerOutcome = classifyGoogleAdsProviderMutationFailure(providerError);
  }

  try {
    return await finalizeGoogleAdsOperation(
      input.db,
      input.mutation,
      dispatch.prepared,
      providerOutcome,
    );
  } catch (persistenceError) {
    if (providerOutcome.state !== "succeeded") throw persistenceError;
    return finalizeGoogleAdsOperation(
      input.db,
      input.mutation,
      dispatch.prepared,
      {
        state: "reconciliation_required",
        providerOperationId: providerOutcome.providerOperationId,
        providerStatus: providerOutcome.providerStatus,
        failureCode: "google_ads_success_persistence_uncertain",
        failureDetail:
          "Google Ads returned a resource, but the CRM could not confirm its first local save. The provider resource is preserved for reconciliation and will not be sent again.",
      },
    );
  }
}

async function completeBulkResult(input: {
  db: ReturnType<typeof getDb>;
  mutation: TeamMutationContext;
  claim: TeamMutationIdempotencyClaim;
  finalized: FinalizedGoogleAdsOperation[];
}): Promise<{
  result: MutationResult<unknown>;
  status: number;
  idempotencyReceiptStored: boolean;
}> {
  const applied = input.finalized.filter(
    (item) => item.recommendationStatus === "applied",
  );
  const failed = input.finalized.filter(
    (item) => item.recommendationStatus === "failed",
  );
  const reconciliation = input.finalized.filter(
    (item) => item.recommendationStatus === "reconciliation_required",
  );

  let result: MutationResult<unknown>;
  let status: number;
  if (failed.length === 0 && reconciliation.length === 0) {
    const first = applied[0];
    if (!first) {
      throw new TeamMutationFailure(
        "internal",
        "The bulk Google Ads result is empty.",
      );
    }
    result = teamMutationSuccessResult(
      input.mutation,
      {
        status: "applied",
        applied: applied.length,
        failed: 0,
        reconciliationRequired: 0,
        items: applied.map((item) => ({
          id: item.recommendationId,
          status: item.recommendationStatus,
          version: item.recommendationVersion,
          operation: item.operation,
        })),
        providerExactlyOnceClaimed: false,
      },
      {
        auditEventId: first.auditEventId,
        committedAt: first.committedAt,
        entityType: "google_ads_analyst_recommendation_batch",
        entityId: input.claim.id,
        version: first.committedAt,
      },
    );
    status = 200;
  } else {
    const failure =
      reconciliation.length > 0
        ? new TeamMutationFailure(
            "conflict",
            `Google Ads applied ${applied.length} change(s); ${reconciliation.length} require reconciliation and ${failed.length} were rejected. Nothing uncertain will be sent again automatically.`,
          )
        : new TeamMutationFailure(
            "provider_failed",
            `Google Ads applied ${applied.length} change(s) and rejected ${failed.length}. Review the recorded item states before trying again.`,
          );
    const terminal = teamMutationExceptionResult(failure);
    result = terminal.result;
    status = terminal.status;
  }

  let idempotencyReceiptStored = true;
  try {
    await input.db.transaction(async (tx) => {
      await completeTeamMutationIdempotency(
        tx,
        input.mutation,
        input.claim,
        result,
        status,
      );
    });
  } catch (error) {
    // Every item already has a durable terminal state and audit. Preserve the
    // real mixed result instead of returning the generic claim error; replay
    // can rebuild this receipt without another provider request.
    idempotencyReceiptStored = false;
    console.error("[google-ads] bulk_apply_idempotency_receipt_pending", {
      operationId: input.mutation.operationId,
      correlationId: input.mutation.correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return { result, status, idempotencyReceiptStored };
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.apply"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "marketing.google_ads_recommendations.bulk_apply",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsed = BulkApplySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Select at most 25 current recommendations and explicitly confirm the Google Ads changes.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          recommendations: "Refresh and review the selected diffs.",
        },
      },
    );
  }
  const uniqueIds = new Set(parsed.data.items.map((item) => item.id));
  if (uniqueIds.size !== parsed.data.items.length) {
    return teamMutationErrorResponse(
      "invalid",
      "Each Google Ads recommendation may be selected only once.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const activeDb = db;
    const orderedItems = [...parsed.data.items].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const batchId = createHash("sha256")
      .update(orderedItems.map((item) => item.id).join(":"), "utf8")
      .digest("hex")
      .slice(0, 24);
    const claimed = await claimTeamMutationIdempotency(activeDb, mutation, {
      route: "POST /api/admin/google/ads/analyst/recommendations/apply/bulk",
      entityType: "google_ads_analyst_recommendation_batch",
      entityId: batchId,
      payload: { ...parsed.data, items: orderedItems },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const access = await googleAdsAccess();
    const prepared = await prepareGoogleAdsRecommendationOperations(
      activeDb,
      mutation,
      claimed.claim,
      orderedItems,
    );

    // Keep dispatch concurrency deliberately small. Each item has an
    // independent durable boundary and terminal audit, so partial provider
    // outcomes stay visible and a crash cannot silently redispatch an item.
    const finalized: FinalizedGoogleAdsOperation[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(3, prepared.length) },
      async () => {
        while (cursor < prepared.length) {
          const index = cursor;
          cursor += 1;
          const item = prepared[index];
          if (!item) continue;
          finalized[index] = await executePreparedOperation({
            db: activeDb,
            mutation,
            prepared: item,
            customerId: access.customerId,
            accessToken: access.accessToken,
          });
        }
      },
    );
    const workerResults = await Promise.allSettled(workers);
    const rejectedWorker = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedWorker) throw rejectedWorker.reason;

    const completed = await completeBulkResult({
      db: activeDb,
      mutation,
      claim: claimed.claim,
      finalized,
    });
    return teamMutationResultResponse(
      completed.result,
      completed.status,
      mutation.correlationId,
      completed.idempotencyReceiptStored
        ? undefined
        : { "x-idempotency-receipt": "pending" },
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[google-ads] bulk_apply_idempotency_settlement_failed", {
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
