import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, contacts, getDb } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  buildContactPurgePreview,
  loadContactPurgeDependencies,
  lockContactPurgeDependencyTables,
} from "@/lib/contact-purge-maintenance";
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
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { requirePermission } from "@/lib/permissions";
import { getVerifiedRequestActor } from "@/lib/verified-actor-context";

type RouteContext = { params: Promise<{ contactId?: string }> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PurgeSchema = z
  .object({
    previewVersion: z.string().regex(/^[0-9a-f]{64}$/u),
    confirmation: z.string().min(1).max(80),
  })
  .strict();

function readCorrelationId(request: NextRequest): string {
  const value = request.headers.get("x-correlation-id")?.trim() ?? "";
  return /^[a-zA-Z0-9._:-]{8,128}$/u.test(value) ? value : randomUUID();
}

function boundedRequestFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return new TeamMutationFailure(
      "invalid",
      "The contact purge request body is invalid.",
    );
  }
  return new TeamMutationFailure(
    error.code === "body_timeout" ? "timeout" : "invalid",
    error.message,
    {
      status: error.status,
      retryable: error.code === "body_timeout",
    },
  );
}

function errorField(error: unknown, key: string): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  const cause = (error as Record<string, unknown>)["cause"];
  return cause && typeof cause === "object" ? errorField(cause, key) : null;
}

function normalizePurgeDatabaseFailure(error: unknown): unknown {
  if (error instanceof TeamMutationFailure) return error;
  const constraint = errorField(error, "constraint");
  const databaseCode = errorField(error, "code");
  if (
    constraint === "contact_purge_recovery_window_guard" ||
    constraint === "contact_purge_foreign_key_dependency_guard" ||
    constraint === "contact_purge_logical_dependency_guard" ||
    constraint === "contact_purge_active_operation_guard"
  ) {
    return new TeamMutationFailure(
      "conflict",
      "The contact is no longer safe to purge. Refresh the dependency preview; no contact data was removed.",
      { retryable: true },
    );
  }
  if (databaseCode === "23503" || databaseCode === "23514") {
    return new TeamMutationFailure(
      "conflict",
      "A database relationship or retention rule blocked the purge. No contact data was removed.",
    );
  }
  if (databaseCode === "55P03" || databaseCode === "57014") {
    return new TeamMutationFailure(
      "timeout",
      "The purge safety inventory could not acquire its locks or finish in time. Nothing was removed; retry after current CRM work settles.",
      { retryable: true },
    );
  }
  if (databaseCode === "40001" || databaseCode === "40P01") {
    return new TeamMutationFailure(
      "conflict",
      "Concurrent CRM work interrupted the purge safety check. Nothing was removed; refresh the preview and retry.",
      { retryable: true },
    );
  }
  return error;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readCorrelationId(request);
  // Preview remains available while the destructive kill switch is active so
  // an Owner can diagnose blockers. Execute declares destructive risk and can
  // never ignore that switch.
  const denied = await requirePermission(request, "contacts.purge", {
    ignoredKillSwitches: ["destructive_mutations"],
  });
  if (denied) {
    denied.headers.set("x-correlation-id", correlationId);
    return denied;
  }
  const actor = getVerifiedRequestActor(request);
  if (
    actor?.type !== "human" ||
    !actor.id ||
    !actor.sessionId ||
    (actor.authMethod !== "team_session" && actor.authMethod !== "break_glass")
  ) {
    return NextResponse.json(
      { error: "forbidden" },
      { status: 403, headers: { "x-correlation-id": correlationId } },
    );
  }

  // Params and database state are intentionally read after authorization.
  const { contactId: rawContactId } = await context.params;
  const contactIdCandidate = rawContactId?.trim() ?? "";
  if (!UUID_PATTERN.test(contactIdCandidate)) {
    return NextResponse.json(
      { error: "invalid_contact_id", message: "Select a valid contact." },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    );
  }
  const contactId = contactIdCandidate.toLowerCase();

  try {
    const db = getDb();
    const preview = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
      const [contact] = await tx
        .select({
          id: contacts.id,
          deletedAt: contacts.deletedAt,
          purgeEligibleAt: contacts.purgeEligibleAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .for("update")
        .limit(1);
      if (!contact) return null;

      const dependencies = await loadContactPurgeDependencies(tx, contactId);
      const result = buildContactPurgePreview({ contact, dependencies });
      const createdAt = new Date();
      const eventId = randomUUID();
      await tx.insert(auditLogs).values({
        id: eventId,
        actorType: "human",
        actorId: actor.id,
        actorRole: actor.role ?? null,
        actorLabel: actor.label ?? null,
        sessionId: actor.sessionId,
        authMethod: actor.authMethod,
        correlationId,
        requiredPermissions: ["contacts.purge"],
        outcome: "succeeded",
        providerOperationId: null,
        idempotencyKeyHash: null,
        action: "contact.purge_previewed",
        entityType: "contact",
        entityId: contactId,
        meta: sanitizeAuditMetadata({
          eventId,
          correlationId,
          sessionId: actor.sessionId,
          authMethod: actor.authMethod,
          requiredPermissions: ["contacts.purge"],
          risk: "read",
          outcome: "succeeded",
          previewVersion: result.previewVersion,
          retentionReason: result.retention.reason,
          executable: result.executable,
          blockingDependencyCount: result.blockingDependencyCount,
          foreignKeyInventoryCount: result.dependencies.filter(
            (dependency) => dependency.sourceKind === "foreign_key",
          ).length,
          piiIncluded: false,
        }),
        createdAt,
      });
      return result;
    });

    if (!preview) {
      return NextResponse.json(
        { error: "contact_not_found", message: "The contact was not found." },
        { status: 404, headers: { "x-correlation-id": correlationId } },
      );
    }
    return NextResponse.json(
      { preview },
      {
        headers: {
          "Cache-Control": "no-store",
          ETag: `"${preview.recordVersion}"`,
          "x-correlation-id": correlationId,
        },
      },
    );
  } catch (error) {
    const databaseCode = errorField(error, "code");
    const timedOut = databaseCode === "55P03" || databaseCode === "57014";
    console.error("[contact-purge] preview_failed", {
      correlationId,
      errorName:
        error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
    });
    return NextResponse.json(
      {
        error: timedOut ? "preview_timeout" : "preview_unavailable",
        message: timedOut
          ? "The dependency preview could not finish while CRM records were changing. Purge remains blocked; retry shortly."
          : "The complete dependency inventory could not be verified. Purge remains blocked; try again later.",
        retryable: true,
      },
      {
        status: timedOut ? 504 : 503,
        headers: { "x-correlation-id": correlationId },
      },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.purge"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "contact.purged",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Route and body state are intentionally read after auth, permission,
  // principal-type, kill-switch, Origin/Host, idempotency, and version gates.
  const { contactId: rawContactId } = await context.params;
  const contactIdCandidate = rawContactId?.trim() ?? "";
  if (!UUID_PATTERN.test(contactIdCandidate)) {
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      code: "invalid",
      metadata: { boundary: "contact_id", contactRemoved: false },
    });
    return teamMutationErrorResponse(
      "invalid",
      "A valid contact ID is required before purge.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { contactId: "Select a valid deleted contact." },
      },
    );
  }
  const contactId = contactIdCandidate.toLowerCase();
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      entityId: contactId,
      code: "invalid",
      metadata: { boundary: "expected_version", contactRemoved: false },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The exact contact version from the purge preview is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the purge preview." },
      },
    );
  }

  let candidate: unknown;
  try {
    candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 2 * 1024,
      deadlineMs: 10_000,
    });
  } catch (error) {
    const failure = boundedRequestFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      entityId: contactId,
      code: failure.code,
      metadata: { boundary: "bounded_input", contactRemoved: false },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const parsed = PurgeSchema.safeParse(candidate);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      entityId: contactId,
      code: "invalid",
      metadata: { boundary: "input_validation", contactRemoved: false },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The purge preview or typed confirmation is invalid.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          previewVersion: "Refresh the complete dependency preview.",
          confirmation: `Type PURGE ${contactId} exactly.`,
        },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/contacts/:contactId/purge",
      entityType: "contact",
      entityId: contactId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
      // Take schema-discovered dependency table locks before the contact row
      // lock. This avoids a dependency-writer/contact-row deadlock and makes
      // the final logical-reference inventory stable through DELETE.
      await lockContactPurgeDependencyTables(tx);
      const [contact] = await tx
        .select({
          id: contacts.id,
          deletedAt: contacts.deletedAt,
          purgeEligibleAt: contacts.purgeEligibleAt,
          updatedAt: contacts.updatedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .for("update")
        .limit(1);
      if (!contact) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact no longer exists. Refresh the recovery list.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, contact.updatedAt);

      const dependencies = await loadContactPurgeDependencies(tx, contactId);
      const preview = buildContactPurgePreview({ contact, dependencies });
      if (parsed.data.previewVersion !== preview.previewVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact dependency preview changed. Nothing was removed; refresh and review it again.",
          {
            retryable: true,
            fieldErrors: { previewVersion: "A fresh preview is required." },
          },
        );
      }
      if (parsed.data.confirmation !== preview.confirmationText) {
        throw new TeamMutationFailure(
          "invalid",
          "The typed purge confirmation does not match this contact.",
          {
            fieldErrors: {
              confirmation: `Type ${preview.confirmationText} exactly.`,
            },
          },
        );
      }
      if (!preview.executable) {
        throw new TeamMutationFailure(
          "conflict",
          preview.retention.eligible
            ? "Linked or unresolved records still block purge. Review the dependency preview; nothing was removed."
            : "The 30-day recovery window has not safely elapsed. Nothing was removed.",
        );
      }

      // The database trigger accepts only this exact row for this transaction
      // and independently repeats retention/dependency checks before DELETE.
      await tx.execute(
        sql`SELECT set_config('app.contact_purge_authorized_id', ${contactId}, true)`,
      );
      const [purged] = await tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.updatedAt, contact.updatedAt),
            isNotNull(contacts.deletedAt),
            isNotNull(contacts.purgeEligibleAt),
          ),
        )
        .returning({ id: contacts.id });
      if (!purged) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact changed before purge. Nothing was removed; refresh the preview.",
          { retryable: true },
        );
      }

      const committedAt = new Date();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: contactId,
        before: {
          lifecycleState: "deleted_recoverable",
          deletedAt: contact.deletedAt?.toISOString() ?? null,
          purgeEligibleAt: contact.purgeEligibleAt?.toISOString() ?? null,
          recordVersion: contact.updatedAt.toISOString(),
        },
        after: {
          lifecycleState: "purged",
          coreContactRowRemoved: true,
        },
        metadata: {
          previewVersion: preview.previewVersion,
          schemaWideForeignKeyInventory: true,
          foreignKeyInventoryCount: preview.dependencies.filter(
            (dependency) => dependency.sourceKind === "foreign_key",
          ).length,
          blockingDependencyCount: 0,
          immutableAuditEvidenceRetained: true,
          immutableProviderEvidenceRetained: true,
          recoveryMethod: "verified_database_backup_only",
          piiIncluded: false,
        },
        committedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          contactId,
          purged: true as const,
          purgedAt: committedAt.toISOString(),
          auditEvidenceRetained: true,
          providerEvidenceRetained: true,
          recoveryMethod: "verified_database_backup_only" as const,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "contact",
          entityId: contactId,
          version: contact.updatedAt.toISOString(),
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
  } catch (rawError) {
    const error = normalizePurgeDatabaseFailure(rawError);
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      entityId: contactId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { boundary: "execute", contactRemoved: false },
    });
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[contact-purge] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name.slice(0, 80)
              : "UnknownError",
        });
        return teamMutationErrorResponse(
          "internal",
          "Purge did not complete and its retry state could not be recorded. Contact support before retrying.",
          { correlationId: mutation.correlationId },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
