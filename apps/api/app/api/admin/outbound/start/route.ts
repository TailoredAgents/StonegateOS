import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
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
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  nextOutboundTaskVersion,
  parseOutboundStartPayload,
  parseOutboundTaskVersion,
  readOutboundMutationRequest,
  requireOutboundExpectedVersion,
} from "@/lib/outbound-mutation-contract";
import { runOutboundMutationAtomic } from "@/lib/outbound-mutation-transaction";

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`(^|\\n)${key}=[^\\n]*`, "iu");
  return pattern.test(notes)
    ? notes.replace(pattern, `$1${line}`)
    : notes.length > 0
      ? `${notes}\n${line}`
      : line;
}

function isOutboundTask(notes: string): boolean {
  return /(?:^|\n)kind=outbound(?:\n|$)/iu.test(notes);
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["outbound.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "outbound.started",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const payload = parseOutboundStartPayload(
      await readOutboundMutationRequest(request, 1_024),
    );
    const expectedVersion = parseOutboundTaskVersion(
      mutation.expectedVersion,
      "If-Match",
    );
    requireOutboundExpectedVersion(mutation.expectedVersion, expectedVersion);

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/admin/outbound/start",
      entityType: "crm_task",
      entityId: payload.taskId,
      payload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await runOutboundMutationAtomic(
      (work) => database.transaction(work),
      async (tx) => {
        const [candidate] = await tx
          .select({ id: crmTasks.id, contactId: crmTasks.contactId })
          .from(crmTasks)
          .where(eq(crmTasks.id, payload.taskId))
          .limit(1);
        if (!candidate) {
          throw new TeamMutationFailure(
            "invalid",
            "The outbound task was not found.",
            {
              status: 404,
              fieldErrors: { taskId: "Refresh the outbound queue." },
            },
          );
        }

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`outbound-disposition:contact:${candidate.contactId}`}, 0))`,
        );
        const [contact] = await tx
          .select({
            id: contacts.id,
            doNotContact: contacts.doNotContact,
            deletedAt: contacts.deletedAt,
          })
          .from(contacts)
          .where(eq(contacts.id, candidate.contactId))
          .for("update")
          .limit(1);
        if (!contact || contact.deletedAt || contact.doNotContact) {
          throw new TeamMutationFailure(
            "conflict",
            "This contact is unavailable or marked Do Not Contact. The cadence was not started.",
          );
        }

        const [task] = await tx
          .select({
            id: crmTasks.id,
            contactId: crmTasks.contactId,
            status: crmTasks.status,
            dueAt: crmTasks.dueAt,
            notes: crmTasks.notes,
            updatedAt: crmTasks.updatedAt,
          })
          .from(crmTasks)
          .where(eq(crmTasks.id, payload.taskId))
          .for("update")
          .limit(1);
        if (!task || task.contactId !== candidate.contactId) {
          throw new TeamMutationFailure(
            "conflict",
            "The outbound task changed while its contact was being verified. Refresh the queue.",
          );
        }

        const currentVersion = task.updatedAt.toISOString();
        requireOutboundExpectedVersion(expectedVersion, currentVersion);
        if (task.status !== "open") {
          throw new TeamMutationFailure(
            "conflict",
            "This outbound task is no longer open. Refresh the queue.",
          );
        }
        const notes = task.notes ?? "";
        if (!isOutboundTask(notes)) {
          throw new TeamMutationFailure(
            "invalid",
            "The selected task is not an outbound cadence task.",
          );
        }

        let version = currentVersion;
        let dueAt = task.dueAt;
        let alreadyStarted = task.dueAt instanceof Date;
        if (!alreadyStarted) {
          const now = new Date();
          const nextUpdatedAt = nextOutboundTaskVersion(task.updatedAt, now);
          const nextNotes = upsertField(notes, "startedAt", now.toISOString());
          const [updated] = await tx
            .update(crmTasks)
            .set({
              dueAt: now,
              notes: nextNotes,
              updatedAt: nextUpdatedAt,
            })
            .where(
              and(
                eq(crmTasks.id, task.id),
                eq(crmTasks.status, "open"),
                eq(crmTasks.updatedAt, task.updatedAt),
              ),
            )
            .returning({
              dueAt: crmTasks.dueAt,
              updatedAt: crmTasks.updatedAt,
            });
          if (!updated) {
            throw new TeamMutationFailure(
              "conflict",
              "The outbound task changed while it was starting. No change was saved.",
              { retryable: true, retryAfter: "1" },
            );
          }
          dueAt = updated.dueAt;
          version = updated.updatedAt.toISOString();
          alreadyStarted = false;
        }

        const committedAt = new Date();
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "crm_task",
          entityId: task.id,
          before: {
            status: task.status,
            dueAt: task.dueAt?.toISOString() ?? null,
            version: currentVersion,
          },
          after: {
            status: task.status,
            dueAt: dueAt?.toISOString() ?? null,
            version,
            alreadyStarted,
          },
          metadata: { contactId: task.contactId },
          committedAt,
        });
        const data = {
          taskId: task.id,
          contactId: task.contactId,
          dueAt: dueAt?.toISOString() ?? null,
          alreadyStarted,
          version,
        };
        const mutationResult = teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task",
          entityId: task.id,
          version,
        });
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          mutationResult,
          200,
        );
        return mutationResult;
      },
    );

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[outbound-start] idempotency_settlement_failed", {
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
