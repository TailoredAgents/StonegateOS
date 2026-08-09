import type { NextRequest } from "next/server";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { getDb, teamMembers, teamSessions } from "@/db";
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
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { selfSessionCollectionVersion } from "@/lib/self-session-management";

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["sessions.manage_self"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "team.sessions.other_revoked",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const payload = (await request.json().catch(() => null)) as {
    scope?: unknown;
  } | null;
  if (payload?.scope !== "others") {
    const error = new TeamMutationFailure(
      "invalid",
      "Choose the other-session revocation scope.",
      { fieldErrors: { scope: "Use the supported other-session scope." } },
    );
    await recordTeamMutationFailure(mutation, {
      outcome: "denied",
      entityType: "team_member",
      entityId: mutation.actor.id ?? null,
      code: error.code,
    });
    return teamMutationExceptionResponse(error, mutation);
  }
  if (!mutation.expectedVersion) {
    const error = new TeamMutationFailure(
      "invalid",
      "The loaded session version is required. Refresh Settings and try again.",
      { fieldErrors: { version: "Refresh the session list." } },
    );
    await recordTeamMutationFailure(mutation, {
      outcome: "denied",
      entityType: "team_member",
      entityId: mutation.actor.id ?? null,
      code: error.code,
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  const memberId = mutation.actor.id;
  const currentSessionId = mutation.actor.sessionId;
  if (!memberId || !currentSessionId) {
    return teamMutationExceptionResponse(
      new TeamMutationFailure(
        "unauthorized",
        "A current team session is required.",
      ),
      mutation,
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/team/sessions/self/revoke",
      entityType: "team_member",
      entityId: memberId,
      payload: { scope: "others" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Session issuance locks the owning member before it inserts a session.
      // Take the same lock, in the same order, so a login that started before
      // this revocation is either included in this snapshot or completes only
      // after this transaction. Without the parent lock PostgreSQL can admit a
      // phantom session after the rows below have already been selected.
      const [member] = await tx
        .select({ id: teamMembers.id, active: teamMembers.active })
        .from(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .for("update")
        .limit(1);
      if (!member?.id || !member.active) {
        throw new TeamMutationFailure(
          "unauthorized",
          "This team account is no longer active.",
        );
      }

      const rows = await tx
        .select({
          id: teamSessions.id,
          authMethod: teamSessions.authMethod,
          createdAt: teamSessions.createdAt,
          expiresAt: teamSessions.expiresAt,
          revokedAt: teamSessions.revokedAt,
        })
        .from(teamSessions)
        .where(eq(teamSessions.teamMemberId, memberId))
        .for("update");

      const currentVersion = selfSessionCollectionVersion(rows);
      if (currentVersion !== mutation.expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "Your session list changed. Refresh Settings before revoking sessions.",
        );
      }
      const currentSession = rows.find(
        (session) => session.id === currentSessionId,
      );
      const revokedAt = new Date();
      if (
        !currentSession ||
        currentSession.revokedAt !== null ||
        currentSession.expiresAt <= revokedAt
      ) {
        throw new TeamMutationFailure(
          "unauthorized",
          "The current session is no longer active.",
        );
      }

      const revocableIds = rows
        .filter(
          (session) =>
            session.id !== currentSessionId &&
            session.revokedAt === null &&
            session.expiresAt > revokedAt,
        )
        .map((session) => session.id);
      if (revocableIds.length > 0) {
        const revokedRows = await tx
          .update(teamSessions)
          .set({ revokedAt })
          .where(
            and(
              eq(teamSessions.teamMemberId, memberId),
              ne(teamSessions.id, currentSessionId),
              isNull(teamSessions.revokedAt),
              gt(teamSessions.expiresAt, revokedAt),
            ),
          )
          .returning({ id: teamSessions.id });
        const expectedIds = [...revocableIds].sort();
        const updatedIds = revokedRows.map((row) => row.id).sort();
        if (
          updatedIds.length !== expectedIds.length ||
          updatedIds.some((id, index) => id !== expectedIds[index])
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "The session list changed while it was being revoked. Refresh Settings and try again.",
          );
        }
      }

      const settledRows = rows.map((session) =>
        revocableIds.includes(session.id) ? { ...session, revokedAt } : session,
      );
      const version = selfSessionCollectionVersion(settledRows);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_member",
        entityId: memberId,
        before: {
          sessionCount: rows.length,
          revocableSessionCount: revocableIds.length,
        },
        after: {
          revokedSessionCount: revocableIds.length,
          currentSessionPreserved: true,
        },
        metadata: { scope: "others" },
        committedAt: revokedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          revokedSessionCount: revocableIds.length,
          currentSessionPreserved: true,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "team_member",
          entityId: memberId,
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

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    await recordTeamMutationFailure(mutation, {
      outcome:
        error instanceof TeamMutationFailure &&
        ["unauthorized", "forbidden", "conflict", "invalid"].includes(
          error.code,
        )
          ? "denied"
          : "failed",
      entityType: "team_member",
      entityId: memberId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
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
