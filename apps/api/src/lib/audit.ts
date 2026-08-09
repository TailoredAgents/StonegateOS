import type { NextRequest } from "next/server";
import { getDb, auditLogs } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getVerifiedRequestActor } from "@/lib/verified-actor-context";

export type AuditActorType = "human" | "ai" | "system" | "worker";

export type AuditActor = {
  type?: AuditActorType;
  id?: string | null;
  role?: string | null;
  label?: string | null;
  sessionId?: string | null;
  authMethod?:
    | "team_session"
    | "break_glass"
    | "partner_session"
    | "service"
    | null;
};

export type AuditOutcome = "attempted" | "succeeded" | "denied" | "failed";

export function getAuditActorFromRequest(request: NextRequest): AuditActor {
  const verified = getVerifiedRequestActor(request);
  if (verified) {
    return {
      type: verified.type,
      id: verified.id,
      role: verified.role,
      label: verified.label,
      sessionId: verified.sessionId,
      authMethod: verified.authMethod,
    };
  }

  // Actor headers are caller assertions, not an audit identity. Permission
  // resolution binds verified human and named-service identities to the
  // request before protected work runs. Anything else is deliberately
  // recorded as an unattributed system event instead of trusting spoofable
  // headers.
  return {};
}

export async function recordAuditEvent(input: {
  actor?: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
  correlationId?: string | null;
  requiredPermissions?: string[] | null;
  outcome?: AuditOutcome | null;
  surface?: string | null;
  providerOperationId?: string | null;
  idempotencyKeyHash?: string | null;
}): Promise<void> {
  const db = getDb();
  const actor = input.actor ?? {};
  const meta = sanitizeAuditMetadata(input.meta);
  const inferredOutcome: AuditOutcome = input.action.includes(".denied")
    ? "denied"
    : input.action.includes(".failed") || input.action.includes(".blocked")
      ? "failed"
      : "succeeded";

  await db.insert(auditLogs).values({
    actorType: actor.type ?? "system",
    actorId: actor.id ?? null,
    actorRole: actor.role ?? null,
    actorLabel: actor.label ?? null,
    sessionId: actor.sessionId ?? null,
    authMethod: actor.authMethod ?? null,
    correlationId: input.correlationId ?? null,
    requiredPermissions: input.requiredPermissions ?? null,
    outcome: input.outcome ?? inferredOutcome,
    surface: input.surface ?? null,
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: input.idempotencyKeyHash ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    meta,
    createdAt: new Date(),
  });
}
