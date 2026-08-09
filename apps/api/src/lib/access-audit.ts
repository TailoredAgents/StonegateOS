import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { auditLogs } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  getVerifiedRequestActor,
  type VerifiedRequestActor,
} from "@/lib/verified-actor-context";

export type AccessAuditAction =
  | "team_member.created"
  | "team_member.updated"
  | "team_member.deleted"
  | "role.created"
  | "role.updated";

export type AccessAuditEntityType = "team_member" | "team_role";

export type VerifiedAccessActor = VerifiedRequestActor & {
  type: "human";
  id: string;
  authMethod: "team_session" | "break_glass";
};

export type AccessAuditMetadata = {
  active?: boolean;
  roleAssigned?: boolean;
  emailConfigured?: boolean;
  phoneConfigured?: boolean;
  changedFields?: string[];
  phoneChanged?: boolean;
  sessionsRevoked?: boolean;
  sessionsRevokedForMembers?: number;
  clearedDefaultAssignee?: boolean;
  permissionCount?: number;
};

export type AccessAuditReceipt = {
  auditEventId: string;
  committedAt: string;
};

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SAFE_CHANGED_FIELDS = new Set([
  "name",
  "email",
  "emailNormalized",
  "emailIdentityStatus",
  "phoneE164",
  "roleId",
  "active",
  "defaultCrewSplitBps",
  "permissionsGrant",
  "permissionsDeny",
  "slug",
  "permissions",
]);

/**
 * Access writes are human-only. The role snapshot below is evidence, never an
 * authorization source; requirePermission has already calculated effective
 * permissions from the current database-backed principal.
 */
export function getVerifiedAccessActor(
  request: NextRequest,
): VerifiedAccessActor | null {
  const actor = getVerifiedRequestActor(request);
  if (
    actor?.type !== "human" ||
    !actor.id ||
    (actor.authMethod !== "team_session" && actor.authMethod !== "break_glass")
  ) {
    return null;
  }
  return actor as VerifiedAccessActor;
}

export function getAccessAuditCorrelationId(request: NextRequest): string {
  const candidate =
    request.headers.get("x-correlation-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    "";
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function sanitizeAccessAuditMetadata(
  metadata: AccessAuditMetadata | undefined,
): AccessAuditMetadata | null {
  if (!metadata) return null;
  const result: AccessAuditMetadata = {};

  for (const key of [
    "active",
    "roleAssigned",
    "emailConfigured",
    "phoneConfigured",
    "phoneChanged",
    "sessionsRevoked",
    "clearedDefaultAssignee",
  ] as const) {
    const value = metadata[key];
    if (typeof value === "boolean") result[key] = value;
  }

  if (Array.isArray(metadata.changedFields)) {
    result.changedFields = Array.from(
      new Set(
        metadata.changedFields.filter((field) =>
          SAFE_CHANGED_FIELDS.has(field),
        ),
      ),
    );
  }

  for (const key of ["sessionsRevokedForMembers", "permissionCount"] as const) {
    const value = metadata[key];
    if (Number.isSafeInteger(value) && (value ?? -1) >= 0) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export class AccessAuditPersistenceError extends Error {
  readonly code = "access_audit_persistence_failed";

  constructor(readonly originalError: unknown) {
    super("Access audit evidence could not be persisted.");
    this.name = "AccessAuditPersistenceError";
  }
}

export function isAccessAuditPersistenceError(
  error: unknown,
): error is AccessAuditPersistenceError {
  return (
    error instanceof AccessAuditPersistenceError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "access_audit_persistence_failed")
  );
}

/**
 * Persist success evidence through the caller's active transaction. The
 * exception is intentional: an Access change must roll back if its verified
 * audit event cannot commit.
 */
export async function insertAccessSuccessAuditEvent(
  tx: TeamMutationTransaction,
  input: {
    actor: VerifiedAccessActor;
    correlationId: string;
    action: AccessAuditAction;
    entityType: AccessAuditEntityType;
    entityId: string;
    metadata?: AccessAuditMetadata;
    committedAt?: Date;
  },
): Promise<AccessAuditReceipt> {
  const auditEventId = randomUUID();
  const committedAt = input.committedAt ?? new Date();

  try {
    await tx.insert(auditLogs).values({
      id: auditEventId,
      actorType: "human",
      actorId: input.actor.id,
      actorRole: input.actor.role ?? null,
      // A stable member ID is sufficient attribution; do not duplicate a
      // person's display name, email, or phone in the append-only ledger.
      actorLabel: null,
      sessionId: input.actor.sessionId ?? null,
      authMethod: input.actor.authMethod,
      correlationId: input.correlationId,
      requiredPermissions: ["access.manage"],
      outcome: "succeeded",
      surface: "/team/admin/access",
      providerOperationId: null,
      idempotencyKeyHash: null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      meta: sanitizeAccessAuditMetadata(input.metadata),
      createdAt: committedAt,
    });
  } catch (error) {
    throw new AccessAuditPersistenceError(error);
  }

  return {
    auditEventId,
    committedAt: committedAt.toISOString(),
  };
}
