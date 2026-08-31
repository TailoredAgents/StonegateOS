import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import {
  replaceQuoteV2SignerCapability,
  revokeQuoteV2Capability,
} from "@/lib/quote-v2-capability-management";
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

const ReplaceSchema = z
  .object({
    confirmation: z.literal("replace_quote_signer_link"),
    quoteRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

const RevokeSchema = z
  .object({
    confirmation: z.literal("revoke_quote_customer_link"),
    quoteRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

type CapabilityParams = {
  params: Promise<{ id?: string; capabilityId?: string }>;
};

function validatedIds(input: {
  id?: string;
  capabilityId?: string;
}): { quoteId: string; capabilityId: string } | null {
  const quoteId = input.id?.trim() ?? "";
  const capabilityId = input.capabilityId?.trim() ?? "";
  return UUID_PATTERN.test(quoteId) && UUID_PATTERN.test(capabilityId)
    ? { quoteId, capabilityId }
    : null;
}

function expectedRevision(value: string | number | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function handleReplaceQuoteV2Capability(
  request: NextRequest,
  context: CapabilityParams,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.send"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.capability_replaced",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const ids = validatedIds(await context.params);
  if (!ids) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid quote and customer link are required.",
      { correlationId: mutation.correlationId },
    );
  }
  if (!isQuoteV2FeatureEnabled("sender")) {
    return teamMutationErrorResponse(
      "forbidden",
      "Customer link management is not enabled for this quote cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = ReplaceSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm the link replacement and provide a reason.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { reason: "Enter a replacement reason." },
      },
    );
  }
  const revision = expectedRevision(mutation.expectedVersion);
  if (!revision || revision !== parsed.data.quoteRevision) {
    return teamMutationErrorResponse(
      "invalid",
      "The current quote revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          version: "Refresh the quote before replacing its link.",
        },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team member could not be resolved.",
      { correlationId: mutation.correlationId },
    );
  }
  const publicBaseUrl = resolvePublicSiteBaseUrl({
    devFallbackLocalhost: true,
  });
  if (!publicBaseUrl) {
    return teamMutationErrorResponse(
      "internal",
      "The customer proposal URL is not configured.",
      { correlationId: mutation.correlationId, retryable: true },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes/:id/capabilities/:capabilityId/replace",
      entityType: "quote_capability",
      entityId: ids.capabilityId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const rawResult = await db.transaction(async (tx) => {
      const replacement = await replaceQuoteV2SignerCapability(tx, {
        ...ids,
        expectedQuoteRevision: revision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        reason: parsed.data.reason,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_capability",
        entityId: replacement.receipt.capabilityId,
        before: {
          capabilityId: replacement.receipt.replacedCapabilityId,
          status: "active",
        },
        after: {
          capabilityId: replacement.receipt.capabilityId,
          status: "active",
          previousLinkReadOnly: true,
        },
        metadata: {
          quoteId: ids.quoteId,
          versionId: replacement.receipt.versionId,
          reason: parsed.data.reason,
        },
      });
      const receiptInput = {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_capability",
        entityId: replacement.receipt.capabilityId,
        version: String(replacement.receipt.quoteRevision),
      } as const;
      // Idempotency storage intentionally receives no bearer URL. Replays
      // prove the replacement happened but cannot reproduce the one-time link.
      const storedResult = teamMutationSuccessResult(
        mutation,
        {
          ...replacement.receipt,
          oneTimeLinkAvailable: false,
          replayGuidance:
            "The replacement link was returned only on the original response. Replace it again if it was not retained.",
        },
        receiptInput,
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        storedResult,
        201,
      );
      const href = new URL(
        `/quote/${encodeURIComponent(replacement.rawToken)}`,
        publicBaseUrl,
      ).toString();
      return teamMutationSuccessResult(
        mutation,
        {
          ...replacement.receipt,
          oneTimeLinkAvailable: true,
          oneTimeLink: {
            href,
            recipientRole: "signer" as const,
          },
        },
        receiptInput,
      );
    });
    return teamMutationResultResponse(rawResult, 201, mutation.correlationId, {
      "Cache-Control": "private, no-store, max-age=0",
    });
  } catch (error) {
    if (claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_capability",
      entityId: ids.capabilityId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { quoteId: ids.quoteId, phase: "replace" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}

export async function handleRevokeQuoteV2Capability(
  request: NextRequest,
  context: CapabilityParams,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.send"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.capability_revoked",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const ids = validatedIds(await context.params);
  if (!ids) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid quote and customer link are required.",
      { correlationId: mutation.correlationId },
    );
  }
  if (!isQuoteV2FeatureEnabled("sender")) {
    return teamMutationErrorResponse(
      "forbidden",
      "Customer link management is not enabled for this quote cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = RevokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm access revocation and provide a reason.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { reason: "Enter a revocation reason." },
      },
    );
  }
  const revision = expectedRevision(mutation.expectedVersion);
  if (!revision || revision !== parsed.data.quoteRevision) {
    return teamMutationErrorResponse(
      "invalid",
      "The current quote revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote before revoking access." },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team member could not be resolved.",
      { correlationId: mutation.correlationId },
    );
  }
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes/:id/capabilities/:capabilityId/revoke",
      entityType: "quote_capability",
      entityId: ids.capabilityId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await revokeQuoteV2Capability(tx, {
        ...ids,
        expectedQuoteRevision: revision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        reason: parsed.data.reason,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_capability",
        entityId: receipt.capabilityId,
        before: { status: "active" },
        after: { status: "revoked", revokedAt: receipt.revokedAt },
        metadata: {
          quoteId: receipt.quoteId,
          versionId: receipt.versionId,
          reason: parsed.data.reason,
        },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_capability",
        entityId: receipt.capabilityId,
        version: String(receipt.quoteRevision),
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
    if (claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_capability",
      entityId: ids.capabilityId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { quoteId: ids.quoteId, phase: "revoke" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
