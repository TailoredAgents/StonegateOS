import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, teamSessions } from "@/db";
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
import {
  getTeamAuthCorrelationId,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

type RevokeScope = "session" | "member";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const unauthenticatedCorrelationId = getTeamAuthCorrelationId(request);
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["access.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "team.session.revoked",
  });
  if (!boundary.ok) {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.session.revoked",
        outcome: "attempted",
        correlationId: unauthenticatedCorrelationId,
        surface: "/team/settings",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.session.revoked",
        outcome: boundary.response.status >= 500 ? "failed" : "denied",
        correlationId: unauthenticatedCorrelationId,
        surface: "/team/settings",
        metadata: {
          reasonCode:
            boundary.response.status >= 500
              ? "authorization_verification_failed"
              : "authorization_denied",
        },
      }),
    ]);
    boundary.response.headers.set(
      "x-correlation-id",
      unauthenticatedCorrelationId,
    );
    return boundary.response;
  }
  const { mutation } = boundary;
  const sessionAuthMethod =
    mutation.actor.authMethod === "team_session" ||
    mutation.actor.authMethod === "break_glass"
      ? mutation.actor.authMethod
      : undefined;
  await recordTeamAuthAuditEventSafely({
    action: "team.session.revoked",
    outcome: "attempted",
    correlationId: mutation.correlationId,
    surface: "/team/settings",
    actor: mutation.actor,
    entityType: "team_session",
    metadata: sessionAuthMethod ? { authMethod: sessionAuthMethod } : undefined,
  });

  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const scope: RevokeScope | null =
    payload?.["scope"] === "session" || payload?.["scope"] === "member"
      ? payload["scope"]
      : null;
  const targetId =
    scope === "session"
      ? typeof payload?.["sessionId"] === "string"
        ? payload["sessionId"].trim()
        : ""
      : typeof payload?.["memberId"] === "string"
        ? payload["memberId"].trim()
        : "";
  if (!scope || !isUuid(targetId)) {
    await recordTeamAuthAuditEventSafely({
      action: "team.session.revoked",
      outcome: "denied",
      correlationId: mutation.correlationId,
      surface: "/team/settings",
      actor: mutation.actor,
      entityType: "team_session",
      metadata: {
        ...(sessionAuthMethod ? { authMethod: sessionAuthMethod } : {}),
        reasonCode: "invalid_target",
      },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid session or team member to revoke.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { target: "A valid revocation target is required." },
      },
    );
  }

  const preserveCurrent =
    scope === "member" &&
    payload?.["preserveCurrent"] === true &&
    targetId === mutation.actor.id;
  if (scope === "session" && targetId === mutation.actor.sessionId) {
    await recordTeamAuthAuditEventSafely({
      action: "team.session.revoked",
      outcome: "denied",
      correlationId: mutation.correlationId,
      surface: "/team/settings",
      actor: mutation.actor,
      entityType: "team_session",
      entityId: targetId,
      metadata: {
        ...(sessionAuthMethod ? { authMethod: sessionAuthMethod } : {}),
        reasonCode: "current_session_requires_logout",
      },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Use Log out to end the current session. Access can revoke other sessions.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/team/sessions/revoke",
      entityType: scope === "session" ? "team_session" : "team_member",
      entityId: targetId,
      payload: { scope, preserveCurrent },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const scopePredicate =
        scope === "session"
          ? eq(teamSessions.id, targetId)
          : eq(teamSessions.teamMemberId, targetId);
      const rows = await tx
        .select({
          id: teamSessions.id,
          memberId: teamSessions.teamMemberId,
          revokedAt: teamSessions.revokedAt,
        })
        .from(teamSessions)
        .where(scopePredicate)
        .for("update");
      if (rows.length === 0) {
        throw new TeamMutationFailure(
          "conflict",
          scope === "session"
            ? "That session no longer exists. Refresh the session list."
            : "That member has no session records to revoke.",
        );
      }

      const revocableIds = rows
        .filter(
          (row) =>
            row.revokedAt === null &&
            (!preserveCurrent || row.id !== mutation.actor.sessionId),
        )
        .map((row) => row.id);
      const revokedAt = new Date();
      if (revocableIds.length > 0) {
        await tx
          .update(teamSessions)
          .set({ revokedAt })
          .where(
            and(
              inArray(teamSessions.id, revocableIds),
              isNull(teamSessions.revokedAt),
              ...(preserveCurrent && mutation.actor.sessionId
                ? [ne(teamSessions.id, mutation.actor.sessionId)]
                : []),
            ),
          );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: scope === "session" ? "team_session" : "team_member",
        entityId: targetId,
        before: {
          sessionCount: rows.length,
          activeSessionCount: rows.filter((row) => row.revokedAt === null)
            .length,
        },
        after: {
          revokedSessionCount: revocableIds.length,
          preservedCurrentSession: preserveCurrent,
        },
        metadata: { scope },
        committedAt: revokedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          scope,
          targetId,
          revokedSessionCount: revocableIds.length,
          preservedCurrentSession: preserveCurrent,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: scope === "session" ? "team_session" : "team_member",
          entityId: targetId,
          version: revokedAt.toISOString(),
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

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    const outcome =
      error instanceof TeamMutationFailure &&
      (error.code === "unauthorized" ||
        error.code === "forbidden" ||
        error.code === "conflict" ||
        error.code === "invalid" ||
        error.code === "rate_limited")
        ? "denied"
        : "failed";
    await recordTeamAuthAuditEventSafely({
      action: "team.session.revoked",
      outcome,
      correlationId: mutation.correlationId,
      surface: "/team/settings",
      actor: mutation.actor,
      entityType: scope === "session" ? "team_session" : "team_member",
      entityId: targetId,
      metadata: {
        ...(sessionAuthMethod ? { authMethod: sessionAuthMethod } : {}),
        reasonCode:
          error instanceof TeamMutationFailure
            ? `mutation_${error.code}`
            : "mutation_failed",
      },
    });
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
