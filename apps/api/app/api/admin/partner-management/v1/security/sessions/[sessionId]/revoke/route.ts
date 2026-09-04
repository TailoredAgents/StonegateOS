import type { NextRequest } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, partnerSessions } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { publicPartnerSessionAuthMethod } from "@/lib/partner-session-auth-policy";

type RouteContext = { params: Promise<{ sessionId?: string }> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const InputSchema = z
  .object({
    partnerUserId: z.string().uuid(),
    accountId: z.string().uuid().nullable(),
    membershipId: z.string().uuid().nullable(),
    reason: z.string().trim().min(12).max(1_000),
    confirmation: z.literal("REVOKE PARTNER SESSION"),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.security.sessions.revoke"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_session.revoked_by_staff",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  const { sessionId: rawSessionId } = await context.params;
  const sessionId = rawSessionId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(sessionId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner session.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { sessionId: "Refresh Partner administration." },
      },
    );
  }
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest session version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the session before continuing." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a revocation reason and the exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          confirmation: "Enter REVOKE PARTNER SESSION exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/security/sessions/:sessionId/revoke",
      entityType: "partner_session",
      entityId: sessionId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM partner_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`,
      );
      const [target] = await tx
        .select({
          id: partnerSessions.id,
          partnerUserId: partnerSessions.partnerUserId,
          activePartnerAccountId: partnerSessions.activePartnerAccountId,
          activeMembershipId: partnerSessions.activeMembershipId,
          authMethod: partnerSessions.authMethod,
          createdAt: partnerSessions.createdAt,
          lastSeenAt: partnerSessions.lastSeenAt,
          expiresAt: partnerSessions.expiresAt,
          revokedAt: partnerSessions.revokedAt,
        })
        .from(partnerSessions)
        .where(eq(partnerSessions.id, sessionId))
        .limit(1);

      if (
        !target ||
        target.partnerUserId !== parsed.data.partnerUserId ||
        target.activePartnerAccountId !== parsed.data.accountId ||
        target.activeMembershipId !== parsed.data.membershipId
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The partner session was not found.",
          { status: 404 },
        );
      }
      if (target.lastSeenAt.toISOString() !== mutation.expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "The session changed after this page was loaded. Refresh before revoking it.",
          {
            status: 412,
            fieldErrors: { version: "Refresh Partner administration." },
          },
        );
      }
      if (target.revokedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "This partner session has already been revoked.",
        );
      }
      const now = new Date();
      if (target.expiresAt <= now) {
        throw new TeamMutationFailure(
          "conflict",
          "This partner session has already expired.",
        );
      }

      const [revoked] = await tx
        .update(partnerSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(partnerSessions.id, sessionId),
            eq(partnerSessions.lastSeenAt, target.lastSeenAt),
            isNull(partnerSessions.revokedAt),
          ),
        )
        .returning({
          id: partnerSessions.id,
          revokedAt: partnerSessions.revokedAt,
        });
      if (!revoked?.revokedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "The session changed while it was being revoked. Refresh before retrying.",
          { status: 412 },
        );
      }

      const version = revoked.revokedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_session",
        entityId: sessionId,
        before: {
          revokedAt: null,
          expiresAt: target.expiresAt.toISOString(),
          authMethod: publicPartnerSessionAuthMethod(target.authMethod),
        },
        after: {
          revokedAt: version,
          expiresAt: target.expiresAt.toISOString(),
          authMethod: publicPartnerSessionAuthMethod(target.authMethod),
        },
        metadata: {
          partnerUserId: target.partnerUserId,
          partnerAccountId: target.activePartnerAccountId,
          membershipId: target.activeMembershipId,
          reason: parsed.data.reason,
          scope: "single_partner_session",
          identityStateChanged: false,
          membershipStateChanged: false,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          sessionId,
          partnerUserId: target.partnerUserId,
          partnerAccountId: target.activePartnerAccountId,
          membershipId: target.activeMembershipId,
          status: "revoked",
          revokedAt: version,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_session",
          entityId: sessionId,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partner-management] session_revoke_settlement_failed", {
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
