import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, instantQuotes } from "@/db";
import {
  InstantQuoteHandoffFailure,
  loadInstantQuoteTeamHandoff,
} from "@/lib/instant-quote-team-handoff";
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
import { isAdminRequest } from "../../../web/admin";

type RouteContext = {
  params: Promise<{ id?: string }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "Authentication required." },
      { status: 401 },
    );
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_instant_quote_id",
        message: "Select a valid instant quote.",
      },
      { status: 422 },
    );
  }

  try {
    const handoff = await loadInstantQuoteTeamHandoff(getDb(), id);
    return NextResponse.json(
      { ok: true, handoff },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InstantQuoteHandoffFailure) {
      return NextResponse.json(
        { ok: false, error: error.code, message: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[instant-quote-handoff] load_failed", {
      instantQuoteId: id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "instant_quote_handoff_failed",
        message: "The quote handoff could not be verified. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.delete"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "instant_quote.deleted",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Params are intentionally read only after the complete trust boundary.
  const { id } = await context.params;
  if (!id || !UUID_PATTERN.test(id)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid instant quote ID is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { id: "Select a valid instant quote." },
      },
    );
  }
  if (
    mutation.expectedVersion === null ||
    mutation.expectedVersion === "*"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest instant quote version is required before deletion.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/admin/instant-quotes/:id",
      entityType: "instant_quote",
      entityId: id,
      payload: { method: "DELETE" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const executableClaim = claimed.claim;
    claim = executableClaim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: instantQuotes.id,
          source: instantQuotes.source,
          createdAt: instantQuotes.createdAt,
        })
        .from(instantQuotes)
        .where(eq(instantQuotes.id, id))
        .for("update")
        .limit(1);
      if (!existing?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The instant quote no longer exists. Refresh the list before continuing.",
        );
      }

      const version = existing.createdAt.toISOString();
      assertTeamMutationExpectedVersion(mutation, version);

      const [deleted] = await tx
        .delete(instantQuotes)
        .where(eq(instantQuotes.id, id))
        .returning({ id: instantQuotes.id });
      if (!deleted?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The instant quote changed while it was being deleted. Refresh and try again.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "instant_quote",
        entityId: deleted.id,
        before: {
          createdAt: version,
          source: existing.source,
        },
        after: { deleted: true },
      });

      const mutationResult = teamMutationSuccessResult(
        mutation,
        { deleted: true },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "instant_quote",
          entityId: deleted.id,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        executableClaim,
        mutationResult,
        200,
      );

      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (claim && db) {
      // Do not mask the truthful business error if ledger settlement is
      // temporarily unavailable; the short lease still enables bounded retry.
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[team-idempotency] failure_settlement_failed", {
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
