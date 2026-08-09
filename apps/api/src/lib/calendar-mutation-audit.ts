import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { auditLogs } from "@/db";
import type { AuditActor } from "@/lib/audit";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function getCalendarMutationCorrelationId(request: NextRequest): string {
  const headers = (request as { headers?: Headers }).headers;
  const candidate =
    headers?.get?.("x-correlation-id")?.trim() ||
    headers?.get?.("x-request-id")?.trim() ||
    "";
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export async function insertCalendarMutationSuccessAudit(
  tx: TeamMutationTransaction,
  input: {
    actor: AuditActor;
    action:
      | "appointment.booked"
      | "appointment.note.created"
      | "appointment.rescheduled"
      | "appointment.status.updated"
      | "property.created";
    entityType: "appointment" | "appointment_note" | "property";
    entityId: string;
    meta?: Record<string, unknown>;
    requiredPermissions: string[];
    correlationId?: string | null;
    committedAt?: Date;
  },
): Promise<{ auditEventId: string }> {
  const auditEventId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: input.actor.type ?? "system",
    actorId: input.actor.id ?? null,
    actorRole: input.actor.role ?? null,
    // Member ID and session are sufficient immutable attribution. Avoid
    // duplicating a person's mutable display label in append-only storage.
    actorLabel: null,
    sessionId: input.actor.sessionId ?? null,
    authMethod: input.actor.authMethod ?? null,
    correlationId: input.correlationId ?? null,
    requiredPermissions: input.requiredPermissions,
    outcome: "succeeded",
    surface: "/team/calendar",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata(input.meta),
    createdAt: input.committedAt ?? new Date(),
  });
  return { auditEventId };
}
