import type { NextRequest } from "next/server";
import { getDb, auditLogs } from "@/db";

export type AuditActorType = "human" | "ai" | "system" | "worker";

export type AuditActor = {
  type?: AuditActorType;
  id?: string | null;
  role?: string | null;
  label?: string | null;
};

const ACTOR_TYPE_SET = new Set<AuditActorType>(["human", "ai", "system", "worker"]);

export function getAuditActorFromRequest(request: NextRequest): AuditActor {
  const rawType = request.headers.get("x-actor-type") ?? undefined;
  const type = rawType && ACTOR_TYPE_SET.has(rawType as AuditActorType)
    ? (rawType as AuditActorType)
    : undefined;

  const actorId = request.headers.get("x-actor-id");
  const actorRole = request.headers.get("x-actor-role");
  const actorLabel = request.headers.get("x-actor-label");

  return {
    type,
    id: actorId && actorId.trim().length > 0 ? actorId : undefined,
    role: actorRole && actorRole.trim().length > 0 ? actorRole : undefined,
    label: actorLabel && actorLabel.trim().length > 0 ? actorLabel : undefined
  };
}

export async function recordAuditEvent(input: {
  actor?: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  const db = getDb();
  const actor = input.actor ?? {};

  await db.insert(auditLogs).values({
    actorType: actor.type ?? "system",
    actorId: actor.id ?? null,
    actorRole: actor.role ?? null,
    actorLabel: actor.label ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    meta: input.meta ?? null,
    createdAt: new Date()
  });
}
