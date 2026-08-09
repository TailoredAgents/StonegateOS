import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { crmTasks, getDb, outboxEvents } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
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
  type TeamMutationTransaction,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ taskId?: string }> };
type ReminderRow = {
  id: string;
  contactId: string;
  title: string;
  dueAt: Date | null;
  assignedTo: string | null;
  status: "open" | "completed";
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_BODY_BYTES = 8 * 1024;
const TITLE_MAXIMUM_LENGTH = 160;
const NOTES_MAXIMUM_LENGTH = 4_000;
const UPDATE_KEYS = new Set(["dueAt", "notes", "title"]);

function serializeReminder(task: ReminderRow) {
  return {
    id: task.id,
    contactId: task.contactId,
    title: task.title,
    dueAt: task.dueAt?.toISOString() ?? null,
    assignedTo: task.assignedTo,
    status: task.status,
    notes: task.notes,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function parseText(
  value: unknown,
  field: "notes" | "title",
  maximumLength: number,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new TeamMutationFailure("invalid", `The ${field} is invalid.`, {
      fieldErrors: { [field]: "Enter plain text." },
    });
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > maximumLength) {
    throw new TeamMutationFailure("invalid", `The ${field} is too long.`, {
      fieldErrors: {
        [field]: `Use ${maximumLength.toLocaleString("en-US")} characters or fewer.`,
      },
    });
  }
  return normalized;
}

function parseUpdateInput(value: unknown): {
  dueAt: Date;
  notes: string | null;
  title: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The reminder update is invalid.",
      {
        fieldErrors: { request: "Refresh this CRM view and try again." },
      },
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 0 ||
    Object.keys(record).some((key) => !UPDATE_KEYS.has(key))
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The reminder update contains unsupported or missing fields.",
      { fieldErrors: { request: "Submit the visible reminder fields only." } },
    );
  }

  const title = parseText(record["title"], "title", TITLE_MAXIMUM_LENGTH);
  if (title === null || title.length === 0) {
    throw new TeamMutationFailure("invalid", "A reminder title is required.", {
      fieldErrors: { title: "Enter a short reminder title." },
    });
  }
  const notes = parseText(record["notes"], "notes", NOTES_MAXIMUM_LENGTH);
  const rawDueAt =
    typeof record["dueAt"] === "string" ? record["dueAt"].trim() : "";
  const dueAt = new Date(rawDueAt);
  if (
    rawDueAt.length > 40 ||
    Number.isNaN(dueAt.getTime()) ||
    dueAt.toISOString() !== rawDueAt
  ) {
    throw new TeamMutationFailure("invalid", "A valid due time is required.", {
      fieldErrors: { dueAt: "Choose a date and time, then try again." },
    });
  }
  return { dueAt, notes: notes || null, title };
}

function inputFailure(error: unknown): TeamMutationFailure {
  if (error instanceof TeamMutationFailure) return error;
  if (error instanceof BoundedJsonRequestError) {
    return new TeamMutationFailure(
      error.code === "body_timeout" ? "timeout" : "invalid",
      error.message,
      {
        status: error.status === 400 ? 422 : error.status,
        retryable: error.code === "body_timeout",
        fieldErrors: { request: "Submit one reminder update." },
      },
    );
  }
  return new TeamMutationFailure("invalid", "The reminder update is invalid.", {
    fieldErrors: { request: "Refresh this CRM view and try again." },
  });
}

function requireTaskIdAndVersion(
  rawTaskId: string | undefined,
  expectedVersion: string | null,
  correlationId: string,
): { taskId: string } | { response: Response } {
  const taskId = rawTaskId?.normalize("NFKC").trim() ?? "";
  if (!UUID_PATTERN.test(taskId)) {
    return {
      response: teamMutationErrorResponse(
        "invalid",
        "A valid reminder ID is required.",
        {
          correlationId,
          fieldErrors: { taskId: "Refresh the reminders and try again." },
        },
      ),
    };
  }
  if (expectedVersion === null || expectedVersion === "*") {
    return {
      response: teamMutationErrorResponse(
        "invalid",
        "The latest reminder version is required.",
        {
          correlationId,
          fieldErrors: { version: "Refresh the reminder and try again." },
        },
      ),
    };
  }
  return { taskId };
}

async function lockReminder(
  tx: TeamMutationTransaction,
  taskId: string,
): Promise<ReminderRow> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${taskId}, 0))`,
  );
  const [reminder] = await tx
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      notes: crmTasks.notes,
      createdAt: crmTasks.createdAt,
      updatedAt: crmTasks.updatedAt,
    })
    .from(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .for("update")
    .limit(1);
  if (!reminder) {
    throw new TeamMutationFailure(
      "conflict",
      "The reminder no longer exists. Refresh and try again.",
    );
  }
  if (!reminder.dueAt) {
    throw new TeamMutationFailure(
      "conflict",
      "This task is not a dated reminder and cannot be changed here.",
    );
  }
  return reminder;
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.write"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "crm.reminder.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const routeState = requireTaskIdAndVersion(
    (await context.params).taskId,
    mutation.expectedVersion,
    mutation.correlationId,
  );
  if ("response" in routeState) return routeState.response;
  if (request.nextUrl.search.length > 0) {
    const failure = new TeamMutationFailure(
      "invalid",
      "Reminder updates do not accept query parameters.",
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "crm_task",
      entityId: routeState.taskId,
      code: failure.code,
      metadata: { boundary: "query" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let input: ReturnType<typeof parseUpdateInput>;
  try {
    input = parseUpdateInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: MAXIMUM_BODY_BYTES,
        deadlineMs: 5_000,
        rejectDuplicateObjectKeys: true,
      }),
    );
  } catch (error) {
    const failure = inputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "crm_task",
      entityId: routeState.taskId,
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/crm/reminders/:taskId",
      entityType: "crm_task",
      entityId: routeState.taskId,
      payload: {
        dueAt: input.dueAt.toISOString(),
        notes: input.notes,
        title: input.title,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const existing = await lockReminder(tx, routeState.taskId);
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      if (existing.status !== "open") {
        throw new TeamMutationFailure(
          "conflict",
          "This reminder is already complete. Refresh before editing it.",
        );
      }

      const dueChanged = existing.dueAt?.getTime() !== input.dueAt.getTime();
      const now = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );
      const [updated] = await tx
        .update(crmTasks)
        .set({
          title: input.title,
          dueAt: input.dueAt,
          notes: input.notes,
          updatedAt: now,
        })
        .where(
          and(
            eq(crmTasks.id, routeState.taskId),
            eq(crmTasks.status, "open"),
            eq(crmTasks.updatedAt, existing.updatedAt),
          ),
        )
        .returning({
          id: crmTasks.id,
          contactId: crmTasks.contactId,
          title: crmTasks.title,
          dueAt: crmTasks.dueAt,
          assignedTo: crmTasks.assignedTo,
          status: crmTasks.status,
          notes: crmTasks.notes,
          createdAt: crmTasks.createdAt,
          updatedAt: crmTasks.updatedAt,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The reminder changed while it was being saved. Refresh and try again.",
          { retryable: true },
        );
      }

      let outboxEventId: string | null = null;
      if (dueChanged) {
        const pendingOutbox = await tx
          .select({ id: outboxEvents.id })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.type, "crm.reminder.sms"),
              sql`(${outboxEvents.payload} ->> 'taskId') = ${routeState.taskId}`,
              isNull(outboxEvents.processedAt),
              isNull(outboxEvents.quarantinedAt),
            ),
          )
          .for("update")
          .limit(2);
        if (pendingOutbox.length > 1) {
          throw new TeamMutationFailure(
            "conflict",
            "This reminder has duplicate pending notifications. Nothing was changed; contact support to reconcile it.",
          );
        }
        if (pendingOutbox[0]) {
          outboxEventId = pendingOutbox[0].id;
          await tx
            .update(outboxEvents)
            .set({ nextAttemptAt: input.dueAt })
            .where(eq(outboxEvents.id, pendingOutbox[0].id));
        } else {
          const [scheduled] = await tx
            .insert(outboxEvents)
            .values({
              type: "crm.reminder.sms",
              payload: { taskId: routeState.taskId },
              nextAttemptAt: input.dueAt,
            })
            .returning({ id: outboxEvents.id });
          if (!scheduled) {
            throw new TeamMutationFailure(
              "internal",
              "The updated notification could not be scheduled. Nothing was changed.",
              { retryable: true },
            );
          }
          outboxEventId = scheduled.id;
        }
      }

      const reminder = serializeReminder(updated);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "crm_task",
        entityId: updated.id,
        before: {
          dueAt: existing.dueAt?.toISOString() ?? null,
          notes: existing.notes,
          title: existing.title,
          updatedAt: existing.updatedAt.toISOString(),
        },
        after: {
          dueAt: reminder.dueAt,
          notes: reminder.notes,
          title: reminder.title,
          updatedAt: reminder.updatedAt,
        },
        metadata: {
          contactId: reminder.contactId,
          dueChanged,
          outboxEventId,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { reminder },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task",
          entityId: updated.id,
          version: reminder.updatedAt,
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
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[crm-reminder-update] idempotency_settlement_failed", {
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

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "crm.reminder.completed",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const routeState = requireTaskIdAndVersion(
    (await context.params).taskId,
    mutation.expectedVersion,
    mutation.correlationId,
  );
  if ("response" in routeState) return routeState.response;
  if (request.nextUrl.search.length > 0) {
    const failure = new TeamMutationFailure(
      "invalid",
      "Reminder completion does not accept query parameters.",
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "crm_task",
      entityId: routeState.taskId,
      code: failure.code,
      metadata: { boundary: "query" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/crm/reminders/:taskId",
      entityType: "crm_task",
      entityId: routeState.taskId,
      payload: { status: "completed" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const existing = await lockReminder(tx, routeState.taskId);
      assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      if (existing.status !== "open") {
        throw new TeamMutationFailure(
          "conflict",
          "This reminder is already complete. Refresh the reminders before retrying.",
        );
      }

      const now = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );
      const [completed] = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.id, routeState.taskId),
            eq(crmTasks.status, "open"),
            eq(crmTasks.updatedAt, existing.updatedAt),
          ),
        )
        .returning({
          id: crmTasks.id,
          contactId: crmTasks.contactId,
          title: crmTasks.title,
          dueAt: crmTasks.dueAt,
          assignedTo: crmTasks.assignedTo,
          status: crmTasks.status,
          notes: crmTasks.notes,
          createdAt: crmTasks.createdAt,
          updatedAt: crmTasks.updatedAt,
        });
      if (!completed) {
        throw new TeamMutationFailure(
          "conflict",
          "The reminder changed while it was being completed. Refresh and try again.",
          { retryable: true },
        );
      }

      const canceledOutbox = await tx
        .update(outboxEvents)
        .set({ processedAt: now })
        .where(
          and(
            eq(outboxEvents.type, "crm.reminder.sms"),
            sql`(${outboxEvents.payload} ->> 'taskId') = ${routeState.taskId}`,
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        )
        .returning({ id: outboxEvents.id });

      const reminder = serializeReminder(completed);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "crm_task",
        entityId: completed.id,
        before: {
          status: existing.status,
          updatedAt: existing.updatedAt.toISOString(),
        },
        after: { status: reminder.status, updatedAt: reminder.updatedAt },
        metadata: {
          canceledOutboxEventIds: canceledOutbox.map((event) => event.id),
          contactId: reminder.contactId,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { reminder },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task",
          entityId: completed.id,
          version: reminder.updatedAt,
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
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[crm-reminder-complete] idempotency_settlement_failed", {
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
