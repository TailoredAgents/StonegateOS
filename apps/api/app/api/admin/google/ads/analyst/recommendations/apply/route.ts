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

const ApplySchema = z.object({
  id: z.string().uuid(),
  confirmation: z.literal("apply_google_ads_change"),
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
      "Google Ads is not configured. No advertising change was attempted.",
    );
  }
  try {
    return { customerId, accessToken: await getGoogleAdsAccessToken() };
  } catch {
    throw new TeamMutationFailure(
      "provider_failed",
      "Google Ads authentication failed before dispatch. No advertising change was attempted.",
      { retryable: true },
    );
  }
}

async function completeApplyResult(
  db: ReturnType<typeof getDb>,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  finalized: FinalizedGoogleAdsOperation,
): Promise<{
  result: MutationResult<unknown>;
  status: number;
  idempotencyReceiptStored: boolean;
}> {
  let result: MutationResult<unknown>;
  let status: number;
  if (finalized.recommendationStatus === "applied") {
    result = teamMutationSuccessResult(
      mutation,
      {
        id: finalized.recommendationId,
        status: finalized.recommendationStatus,
        version: finalized.recommendationVersion,
        operation: finalized.operation,
        providerExactlyOnceClaimed: false,
      },
      {
        auditEventId: finalized.auditEventId,
        committedAt: finalized.committedAt,
        entityType: "google_ads_analyst_recommendation",
        entityId: finalized.recommendationId,
        version: finalized.recommendationVersion,
      },
    );
    status = 200;
  } else {
    const failure =
      finalized.recommendationStatus === "reconciliation_required"
        ? new TeamMutationFailure(
            "conflict",
            "Google Ads may have accepted this change. It is quarantined for reconciliation and will not be sent again automatically.",
          )
        : new TeamMutationFailure(
            "provider_failed",
            "Google Ads rejected this change. Review the recorded failure before reapproving it.",
          );
    const terminal = teamMutationExceptionResult(failure);
    result = terminal.result;
    status = terminal.status;
  }

  let idempotencyReceiptStored = true;
  try {
    await db.transaction(async (tx) => {
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claim,
        result,
        status,
      );
    });
  } catch (error) {
    // The durable provider operation and terminal audit already committed.
    // Never replace that truthful result with the generic claim error (which
    // would incorrectly say no change was saved). A later same-key request
    // reconstructs the receipt from the operation ledger without redispatch.
    idempotencyReceiptStored = false;
    console.error("[google-ads] apply_idempotency_receipt_pending", {
      operationId: mutation.operationId,
      correlationId: mutation.correlationId,
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
    auditAction: "marketing.google_ads_recommendation.apply",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest recommendation version is required before applying it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh and review the current proposal." },
      },
    );
  }
  const parsed = ApplySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Explicit confirmation is required before changing Google Ads.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Review and confirm the proposed diff." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/google/ads/analyst/recommendations/apply",
      entityType: "google_ads_analyst_recommendation",
      entityId: parsed.data.id,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    // OAuth is a read-only preflight. It runs before the durable dispatch
    // boundary so an authentication failure can be retried safely.
    const access = await googleAdsAccess();
    const [prepared] = await prepareGoogleAdsRecommendationOperations(
      db,
      mutation,
      claimed.claim,
      [{ id: parsed.data.id, expectedVersion: mutation.expectedVersion }],
    );
    if (!prepared) {
      throw new TeamMutationFailure(
        "internal",
        "The Google Ads operation could not be prepared.",
      );
    }

    const dispatch = await claimGoogleAdsOperationDispatch(
      db,
      mutation,
      prepared,
    );
    let finalized: FinalizedGoogleAdsOperation;
    if (dispatch.kind === "terminal") {
      finalized = finalizedGoogleAdsOperationFromPrepared(dispatch.prepared);
    } else if (dispatch.kind === "uncertain") {
      finalized = await finalizeGoogleAdsOperation(
        db,
        mutation,
        dispatch.prepared,
        {
          state: "reconciliation_required",
          providerOperationId: null,
          providerStatus: null,
          failureCode: "google_ads_dispatched_attempt_interrupted",
          failureDetail:
            "A previous request stopped after the provider dispatch boundary. The change was not sent again and requires reconciliation.",
        },
      );
    } else {
      let providerOutcome: Parameters<typeof finalizeGoogleAdsOperation>[3];
      try {
        const providerResult = await applyCustomerNegativeKeyword({
          customerId: access.customerId,
          accessToken: access.accessToken,
          term: dispatch.prepared.operation.term,
        });
        providerOutcome = {
          state: "succeeded",
          providerOperationId: providerResult.resourceName,
          providerStatus: providerResult.providerStatus,
          failureCode: null,
          failureDetail: null,
        };
      } catch (providerError) {
        providerOutcome =
          classifyGoogleAdsProviderMutationFailure(providerError);
      }
      try {
        finalized = await finalizeGoogleAdsOperation(
          db,
          mutation,
          dispatch.prepared,
          providerOutcome,
        );
      } catch (persistenceError) {
        if (providerOutcome.state !== "succeeded") throw persistenceError;
        // The provider confirmed success but the first persistence attempt did
        // not. A second transaction records the known resource as requiring
        // reconciliation; it never sends the provider request again.
        finalized = await finalizeGoogleAdsOperation(
          db,
          mutation,
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

    const completed = await completeApplyResult(
      db,
      mutation,
      claimed.claim,
      finalized,
    );
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
        console.error("[google-ads] apply_idempotency_settlement_failed", {
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
