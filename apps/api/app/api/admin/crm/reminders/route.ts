import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { contacts, crmTasks, getDb, outboxEvents, teamMembers } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_BODY_BYTES = 8 * 1024;
const TITLE_MAXIMUM_LENGTH = 160;
const NOTES_MAXIMUM_LENGTH = 4_000;
const INPUT_KEYS = new Set([
  "assignedTo",
  "contactId",
  "dueAt",
  "notes",
  "title",
]);

type ReminderInput = {
  assignedTo: string | null;
  contactId: string;
  dueAt: Date;
  notes: string | null;
  title: string;
};

function readOptionalText(
  value: unknown,
  field: "notes" | "title",
  maximumLength: number,
): string | null {
  if (value === undefined || value === null) return null;
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
  return normalized || null;
}

function parseReminderInput(value: unknown): ReminderInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The reminder request is invalid.",
      {
        fieldErrors: { request: "Refresh this CRM view and try again." },
      },
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !INPUT_KEYS.has(key))) {
    throw new TeamMutationFailure(
      "invalid",
      "The reminder request contains unsupported fields.",
      { fieldErrors: { request: "Submit one reminder from the CRM form." } },
    );
  }

  const contactId =
    typeof record["contactId"] === "string"
      ? record["contactId"].normalize("NFKC").trim()
      : "";
  if (!UUID_PATTERN.test(contactId)) {
    throw new TeamMutationFailure("invalid", "A valid contact is required.", {
      fieldErrors: { contactId: "Select an active contact." },
    });
  }

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

  const rawAssignedTo = record["assignedTo"];
  const assignedTo =
    rawAssignedTo === undefined || rawAssignedTo === null
      ? null
      : typeof rawAssignedTo === "string"
        ? rawAssignedTo.normalize("NFKC").trim()
        : "";
  if (assignedTo !== null && !UUID_PATTERN.test(assignedTo)) {
    throw new TeamMutationFailure("invalid", "The assignee is invalid.", {
      fieldErrors: { assignedTo: "Choose an active team member." },
    });
  }

  return {
    assignedTo,
    contactId,
    dueAt,
    notes: readOptionalText(record["notes"], "notes", NOTES_MAXIMUM_LENGTH),
    title:
      readOptionalText(record["title"], "title", TITLE_MAXIMUM_LENGTH) ??
      "Call back",
  };
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
        fieldErrors: { request: "Submit one reminder from the CRM form." },
      },
    );
  }
  return new TeamMutationFailure(
    "invalid",
    "The reminder request is invalid.",
    {
      fieldErrors: { request: "Refresh this CRM view and try again." },
    },
  );
}

function serializeReminder(task: {
  id: string;
  contactId: string;
  title: string;
  dueAt: Date | null;
  assignedTo: string | null;
  status: "open" | "completed";
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
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

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.write"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "crm.reminder.created",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  if (request.nextUrl.search.length > 0) {
    const failure = new TeamMutationFailure(
      "invalid",
      "Reminder creation does not accept query parameters.",
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "crm_task",
      code: failure.code,
      metadata: { boundary: "query" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let input: ReminderInput;
  try {
    input = parseReminderInput(
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
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/crm/reminders",
      entityType: "contact",
      entityId: input.contactId,
      payload: {
        assignedTo: input.assignedTo,
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.contactId}, 0))`,
      );
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(eq(contacts.id, input.contactId), isNull(contacts.deletedAt)),
        )
        .for("update")
        .limit(1);
      if (!contact) {
        throw new TeamMutationFailure(
          "conflict",
          "The contact no longer exists or is no longer active. Refresh and try again.",
        );
      }

      let assignedTo = input.assignedTo;
      if (!assignedTo) assignedTo = await getDefaultSalesAssigneeMemberId(tx);
      if (!assignedTo) {
        throw new TeamMutationFailure(
          "invalid",
          "An assignee is required before a reminder notification can be scheduled.",
          {
            fieldErrors: {
              assignedTo: "Choose an assignee or configure the sales default.",
            },
          },
        );
      }
      const [assignee] = await tx
        .select({ id: teamMembers.id, phoneE164: teamMembers.phoneE164 })
        .from(teamMembers)
        .where(
          and(eq(teamMembers.id, assignedTo), eq(teamMembers.active, true)),
        )
        .limit(1);
      if (!assignee) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected assignee is no longer active.",
          { fieldErrors: { assignedTo: "Choose an active team member." } },
        );
      }
      if (!assignee.phoneE164) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected assignee does not have a verified reminder phone number.",
          {
            fieldErrors: {
              assignedTo: "Add the assignee's phone in Access, then retry.",
            },
          },
        );
      }

      const now = new Date();
      const [task] = await tx
        .insert(crmTasks)
        .values({
          contactId: input.contactId,
          title: input.title,
          notes: input.notes,
          dueAt: input.dueAt,
          assignedTo,
          status: "open",
          createdAt: now,
          updatedAt: now,
        })
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
      if (!task) {
        throw new TeamMutationFailure(
          "internal",
          "The reminder could not be saved. Try again.",
          { retryable: true },
        );
      }

      const [outbox] = await tx
        .insert(outboxEvents)
        .values({
          type: "crm.reminder.sms",
          payload: { taskId: task.id },
          nextAttemptAt: input.dueAt,
        })
        .returning({ id: outboxEvents.id });
      if (!outbox) {
        throw new TeamMutationFailure(
          "internal",
          "The reminder notification could not be scheduled. Nothing was saved.",
          { retryable: true },
        );
      }

      const reminder = serializeReminder(task);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "crm_task",
        entityId: task.id,
        after: {
          assignedTo: reminder.assignedTo,
          contactId: reminder.contactId,
          dueAt: reminder.dueAt,
          status: reminder.status,
          updatedAt: reminder.updatedAt,
        },
        metadata: { contactId: reminder.contactId, outboxEventId: outbox.id },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { reminder },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_task",
          entityId: task.id,
          version: reminder.updatedAt,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[crm-reminders] idempotency_settlement_failed", {
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
