import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { DateTime } from "luxon";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { contacts, crmTasks, getDb, outboxEvents } from "@/db";
import { resolveOutboundImportAssignee } from "@/lib/outbound-import-service";
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
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  nextOutboundTaskVersion,
  outboundBulkVersion,
  parseOutboundBulkPayload,
  readOutboundMutationRequest,
  requireOutboundExpectedVersion,
  type OutboundSnoozePreset,
} from "@/lib/outbound-mutation-contract";
import { runOutboundMutationAtomic } from "@/lib/outbound-mutation-transaction";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

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

function hasStartedAt(notes: string): boolean {
  return /(?:^|\n)startedAt=[^\n]+(?:\n|$)/iu.test(notes);
}

function computeSnoozeDueAt(input: {
  preset: OutboundSnoozePreset;
  now: Date;
  timezone: string;
}): Date {
  const nowLocal = DateTime.fromJSDate(input.now, {
    zone: input.timezone || "America/New_York",
  });
  const atTime = (date: DateTime, hour: number) =>
    date.set({ hour, minute: 0, second: 0, millisecond: 0 });

  switch (input.preset) {
    case "today_5pm": {
      const today = atTime(nowLocal, 17);
      return (
        today <= nowLocal ? atTime(nowLocal.plus({ days: 1 }), 17) : today
      )
        .toUTC()
        .toJSDate();
    }
    case "tomorrow_9am":
      return atTime(nowLocal.plus({ days: 1 }), 9)
        .toUTC()
        .toJSDate();
    case "plus_3d_9am":
      return atTime(nowLocal.plus({ days: 3 }), 9)
        .toUTC()
        .toJSDate();
    case "plus_7d_9am":
      return atTime(nowLocal.plus({ days: 7 }), 9)
        .toUTC()
        .toJSDate();
    case "next_monday_9am": {
      const daysUntil = (8 - nowLocal.weekday) % 7 || 7;
      return atTime(nowLocal.plus({ days: daysUntil }), 9)
        .toUTC()
        .toJSDate();
    }
  }
}

async function ensureReminderOutbox(
  tx: TeamMutationTransaction,
  taskId: string,
  dueAt: Date,
): Promise<void> {
  const [existing] = await tx
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "crm.reminder.sms"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`(${outboxEvents.payload} ->> 'taskId') = ${taskId}`,
      ),
    )
    .for("update")
    .limit(1);
  if (existing) {
    await tx
      .update(outboxEvents)
      .set({ nextAttemptAt: dueAt })
      .where(eq(outboxEvents.id, existing.id));
    return;
  }
  await tx.insert(outboxEvents).values({
    type: "crm.reminder.sms",
    payload: { taskId },
    nextAttemptAt: dueAt,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["outbound.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "outbound.bulk_updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const payload = parseOutboundBulkPayload(
      await readOutboundMutationRequest(request, 96 * 1_024),
    );
    const submittedVersion = outboundBulkVersion(payload.tasks);
    requireOutboundExpectedVersion(mutation.expectedVersion, submittedVersion);

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/admin/outbound/bulk",
      entityType: "crm_task_batch",
      entityId: submittedVersion,
      payload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await runOutboundMutationAtomic(
      (work) => database.transaction(work),
      async (tx) => {
        const taskIds = payload.tasks.map((task) => task.id).sort();
        const candidates = await tx
          .select({ id: crmTasks.id, contactId: crmTasks.contactId })
          .from(crmTasks)
          .where(inArray(crmTasks.id, taskIds))
          .orderBy(asc(crmTasks.id));
        if (candidates.length !== taskIds.length) {
          throw new TeamMutationFailure(
            "conflict",
            "One or more selected outbound tasks no longer exist. Nothing was changed.",
          );
        }

        const candidateContactByTask = new Map(
          candidates.map((row) => [row.id, row.contactId] as const),
        );
        const contactIds = Array.from(
          new Set(candidates.map((row) => row.contactId)),
        ).sort();
        for (const contactId of contactIds) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
          );
        }
        for (const contactId of contactIds) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`outbound-disposition:contact:${contactId}`}, 0))`,
          );
        }
        const contactRows = await tx
          .select({
            id: contacts.id,
            doNotContact: contacts.doNotContact,
            deletedAt: contacts.deletedAt,
          })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
          .orderBy(asc(contacts.id))
          .for("update");
        const contactById = new Map(
          contactRows.map((contact) => [contact.id, contact] as const),
        );
        const continuesCadence =
          payload.action === "start" ||
          payload.action === "assign_start" ||
          payload.action === "snooze";
        const blockedContact = contactIds.some((contactId) => {
          const contact = contactById.get(contactId);
          return (
            !contact ||
            Boolean(contact.deletedAt) ||
            (continuesCadence && contact.doNotContact)
          );
        });
        if (blockedContact) {
          throw new TeamMutationFailure(
            "conflict",
            continuesCadence
              ? "One or more selected contacts are unavailable or marked Do Not Contact. Nothing was changed."
              : "One or more selected contacts are unavailable. Nothing was changed.",
          );
        }

        const rows = await tx
          .select({
            id: crmTasks.id,
            contactId: crmTasks.contactId,
            status: crmTasks.status,
            dueAt: crmTasks.dueAt,
            assignedTo: crmTasks.assignedTo,
            notes: crmTasks.notes,
            updatedAt: crmTasks.updatedAt,
          })
          .from(crmTasks)
          .where(inArray(crmTasks.id, taskIds))
          .orderBy(asc(crmTasks.id))
          .for("update");
        if (rows.length !== taskIds.length) {
          throw new TeamMutationFailure(
            "conflict",
            "One or more selected outbound tasks no longer exist. Nothing was changed.",
          );
        }

        const submittedById = new Map(
          payload.tasks.map((task) => [task.id, task.version] as const),
        );
        for (const row of rows) {
          if (candidateContactByTask.get(row.id) !== row.contactId) {
            throw new TeamMutationFailure(
              "conflict",
              "One or more selected tasks changed contacts while the batch was being verified. Nothing was changed.",
            );
          }
          requireOutboundExpectedVersion(
            submittedById.get(row.id) ?? null,
            row.updatedAt.toISOString(),
          );
          if (row.status !== "open" || !isOutboundTask(row.notes ?? "")) {
            throw new TeamMutationFailure(
              "conflict",
              "One or more selected rows are no longer open outbound tasks. Nothing was changed.",
            );
          }
          if (
            payload.action === "snooze" &&
            !(row.dueAt instanceof Date) &&
            !hasStartedAt(row.notes ?? "")
          ) {
            throw new TeamMutationFailure(
              "invalid",
              "Start every selected cadence before snoozing it. Nothing was changed.",
              {
                fieldErrors: {
                  tasks: "Remove unstarted rows or start them first.",
                },
              },
            );
          }
        }

        if (payload.assignedToMemberId) {
          await resolveOutboundImportAssignee(tx, payload.assignedToMemberId);
        }
        const now = new Date();
        const config =
          payload.action === "snooze"
            ? await getSalesScorecardConfig(tx)
            : null;
        const snoozeDueAt =
          payload.action === "snooze" && payload.snoozePreset
            ? computeSnoozeDueAt({
                preset: payload.snoozePreset,
                now,
                timezone: config?.timezone ?? "America/New_York",
              })
            : null;

        let updated = 0;
        let skipped = 0;
        let started = 0;
        let assigned = 0;
        let snoozed = 0;
        const versions: Array<{ id: string; version: string }> = [];

        for (const row of rows) {
          const patch: Partial<typeof crmTasks.$inferInsert> = {};
          let nextNotes = row.notes ?? "";
          if (
            (payload.action === "assign" ||
              payload.action === "assign_start") &&
            row.assignedTo !== payload.assignedToMemberId
          ) {
            patch.assignedTo = payload.assignedToMemberId;
            assigned += 1;
          }
          if (
            (payload.action === "start" || payload.action === "assign_start") &&
            !(row.dueAt instanceof Date)
          ) {
            patch.dueAt = now;
            nextNotes = upsertField(nextNotes, "startedAt", now.toISOString());
            started += 1;
          }
          if (payload.action === "snooze" && snoozeDueAt) {
            if (row.dueAt?.getTime() !== snoozeDueAt.getTime()) {
              patch.dueAt = snoozeDueAt;
              snoozed += 1;
            }
          }
          if (nextNotes !== row.notes) patch.notes = nextNotes;

          if (Object.keys(patch).length === 0) {
            skipped += 1;
            versions.push({ id: row.id, version: row.updatedAt.toISOString() });
            if (payload.action === "snooze" && snoozeDueAt) {
              await ensureReminderOutbox(tx, row.id, snoozeDueAt);
            }
            continue;
          }

          const nextUpdatedAt = nextOutboundTaskVersion(row.updatedAt, now);
          patch.updatedAt = nextUpdatedAt;
          const [changed] = await tx
            .update(crmTasks)
            .set(patch)
            .where(
              and(
                eq(crmTasks.id, row.id),
                eq(crmTasks.status, "open"),
                eq(crmTasks.updatedAt, row.updatedAt),
              ),
            )
            .returning({ id: crmTasks.id, updatedAt: crmTasks.updatedAt });
          if (!changed) {
            throw new TeamMutationFailure(
              "conflict",
              "A selected task changed during the bulk update. Nothing was changed.",
              { retryable: true, retryAfter: "1" },
            );
          }
          updated += 1;
          versions.push({
            id: changed.id,
            version: changed.updatedAt.toISOString(),
          });
          if (payload.action === "snooze" && snoozeDueAt) {
            await ensureReminderOutbox(tx, row.id, snoozeDueAt);
          }
        }

        versions.sort((left, right) => left.id.localeCompare(right.id));
        const resultVersion = outboundBulkVersion(versions);
        const data = {
          action: payload.action,
          taskCount: rows.length,
          assignedToMemberId: payload.assignedToMemberId,
          snoozePreset: payload.snoozePreset,
          snoozeDueAt: snoozeDueAt?.toISOString() ?? null,
          updated,
          skipped,
          started,
          assigned,
          snoozed,
          tasks: versions,
          version: resultVersion,
        };
        const committedAt = new Date();
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "crm_task_batch",
          entityId: submittedVersion,
          before: {
            version: submittedVersion,
            taskCount: rows.length,
          },
          after: {
            version: resultVersion,
            updated,
            skipped,
            started,
            assigned,
            snoozed,
          },
          metadata: {
            action: payload.action,
            assignedToMemberId: payload.assignedToMemberId,
            snoozePreset: payload.snoozePreset,
            taskIds,
          },
          committedAt,
        });
        const mutationResult = teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task_batch",
          entityId: submittedVersion,
          version: resultVersion,
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
        console.error("[outbound-bulk] idempotency_settlement_failed", {
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
