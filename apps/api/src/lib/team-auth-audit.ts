import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { auditLogs } from "@/db";
import {
  recordAuditEvent,
  type AuditActor,
  type AuditOutcome,
} from "@/lib/audit";
import type { TeamSessionAuthMethod } from "@/lib/team-auth";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export type TeamAuthAuditAction =
  | "team.auth.magic_link.request"
  | "team.auth.magic_link.consume"
  | "team.auth.magic_link.exchange"
  | "team.auth.password.login"
  | "team.auth.logout"
  | "team.auth.password.setup"
  | "team.auth.password.change"
  | "team.auth.password.update"
  | "team.session.revoked";

export type TeamAuthAuditMetadata = {
  reasonCode?: string;
  identityKind?: "email" | "phone" | "unknown";
  redirectTarget?: "/team/auth" | "/mobile/auth";
  deliveryChannels?: Array<"email" | "sms">;
  passwordMode?: "setup" | "change";
  revokedSessionCount?: number;
  authMethod?: TeamSessionAuthMethod;
  tokenConsumed?: boolean;
  sessionCreated?: boolean;
};

export type VerifiedTeamAuthAuditActor = {
  type: "human";
  id: string;
  role: string | null;
  sessionId: string;
  authMethod: TeamSessionAuthMethod;
};

export type TeamAuthSuccessAuditContext = {
  correlationId: string;
  surface: "/team/login" | "/team/auth" | "/team/settings" | "/team";
};

export type TeamAuthSuccessAuditReceipt = {
  auditEventId: string;
  committedAt: string;
};

const CORRELATION_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32}|[0-9A-HJKMNP-TV-Z]{26})$/iu;

function sanitizeTeamAuthAuditMetadata(
  metadata: TeamAuthAuditMetadata | undefined,
): TeamAuthAuditMetadata | null {
  if (!metadata) return null;
  const result: TeamAuthAuditMetadata = {};
  if (
    typeof metadata.reasonCode === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(metadata.reasonCode)
  ) {
    result.reasonCode = metadata.reasonCode;
  }
  if (
    metadata.identityKind === "email" ||
    metadata.identityKind === "phone" ||
    metadata.identityKind === "unknown"
  ) {
    result.identityKind = metadata.identityKind;
  }
  if (
    metadata.redirectTarget === "/team/auth" ||
    metadata.redirectTarget === "/mobile/auth"
  ) {
    result.redirectTarget = metadata.redirectTarget;
  }
  if (metadata.deliveryChannels) {
    result.deliveryChannels = Array.from(
      new Set(
        metadata.deliveryChannels.filter(
          (channel): channel is "email" | "sms" =>
            channel === "email" || channel === "sms",
        ),
      ),
    );
  }
  if (metadata.passwordMode === "setup" || metadata.passwordMode === "change") {
    result.passwordMode = metadata.passwordMode;
  }
  if (
    typeof metadata.revokedSessionCount === "number" &&
    Number.isSafeInteger(metadata.revokedSessionCount) &&
    metadata.revokedSessionCount >= 0
  ) {
    result.revokedSessionCount = metadata.revokedSessionCount;
  }
  if (
    metadata.authMethod === "team_session" ||
    metadata.authMethod === "break_glass"
  ) {
    result.authMethod = metadata.authMethod;
  }
  if (typeof metadata.tokenConsumed === "boolean") {
    result.tokenConsumed = metadata.tokenConsumed;
  }
  if (typeof metadata.sessionCreated === "boolean") {
    result.sessionCreated = metadata.sessionCreated;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function getTeamAuthCorrelationId(request: NextRequest): string {
  const candidate =
    request.headers.get("x-correlation-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    "";
  return CORRELATION_ID_PATTERN.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export function getVerifiedTeamAuthActor(input: {
  memberId: string;
  roleSlug?: string | null;
  sessionId: string;
  authMethod: TeamSessionAuthMethod;
}): VerifiedTeamAuthAuditActor {
  return {
    type: "human",
    id: input.memberId,
    role: input.roleSlug ?? null,
    sessionId: input.sessionId,
    authMethod: input.authMethod,
  };
}

/**
 * Persist a verified authentication success through the caller's transaction.
 * Authentication state must roll back if this evidence cannot be committed.
 */
export async function insertTeamAuthSuccessAuditEvent(
  tx: TeamMutationTransaction,
  input: TeamAuthSuccessAuditContext & {
    action: TeamAuthAuditAction;
    actor: VerifiedTeamAuthAuditActor;
    entityType: "team_member" | "team_session";
    entityId: string;
    metadata?: TeamAuthAuditMetadata;
    committedAt?: Date;
  },
): Promise<TeamAuthSuccessAuditReceipt> {
  const auditEventId = crypto.randomUUID();
  const committedAt = input.committedAt ?? new Date();

  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorRole: input.actor.role,
    actorLabel: null,
    sessionId: input.actor.sessionId,
    authMethod: input.actor.authMethod,
    correlationId: input.correlationId,
    requiredPermissions: null,
    outcome: "succeeded",
    surface: input.surface,
    providerOperationId: null,
    idempotencyKeyHash: null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeTeamAuthAuditMetadata(input.metadata),
    createdAt: committedAt,
  });

  return {
    auditEventId,
    committedAt: committedAt.toISOString(),
  };
}

/**
 * Public attempted, denied, and failed observations are deliberately
 * best-effort so degraded observability cannot create an authentication
 * oracle. Successful state transitions use insertTeamAuthSuccessAuditEvent
 * inside their database transaction instead.
 */
export async function recordTeamAuthAuditEventSafely(input: {
  action: TeamAuthAuditAction;
  outcome: AuditOutcome;
  correlationId: string;
  surface: "/team/login" | "/team/auth" | "/team/settings" | "/team";
  actor?: AuditActor;
  entityType?: "team_authentication" | "team_member" | "team_session";
  entityId?: string | null;
  metadata?: TeamAuthAuditMetadata;
}): Promise<boolean> {
  try {
    await recordAuditEvent({
      actor: input.actor,
      action: input.action,
      entityType: input.entityType ?? "team_authentication",
      entityId: input.entityId ?? null,
      meta: sanitizeTeamAuthAuditMetadata(input.metadata),
      correlationId: input.correlationId,
      outcome: input.outcome,
      surface: input.surface,
    });
    return true;
  } catch {
    console.error("[team.auth.audit] write_failed", {
      action: input.action,
      outcome: input.outcome,
      correlationId: input.correlationId,
    });
    return false;
  }
}
