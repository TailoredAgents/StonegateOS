import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, desc, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import {
  contacts,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  leadAutomationStates,
} from "@/db";
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
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const DISPOSITION_SET = [
  "spam",
  "not_a_lead",
  "out_of_state",
  "out_of_area",
  "do_not_contact",
  "bad_phone",
  "duplicate",
  "handled",
] as const;

type Disposition = (typeof DISPOSITION_SET)[number];

type SalesDispositionData = {
  contactId: string;
  disposition: Disposition;
  changed: boolean;
  markLost: boolean;
  completedTaskCount: number;
  dispositionTaskId: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITION_SET as readonly string[]).includes(value);
}

function titleForDisposition(value: Disposition): string {
  switch (value) {
    case "spam":
      return "Spam";
    case "not_a_lead":
      return "Not a lead";
    case "out_of_state":
      return "Out of state";
    case "out_of_area":
      return "Out of area";
    case "do_not_contact":
      return "Do not contact";
    case "bad_phone":
      return "Bad phone";
    case "duplicate":
      return "Duplicate";
    case "handled":
      return "Handled";
  }
}

function shouldMarkLost(value: Disposition): boolean {
  return value !== "bad_phone";
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["sales.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sales.disposition.set",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const payload = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const contactId = readString(payload?.["contactId"])?.trim() ?? "";
  const dispositionRaw =
    readString(payload?.["disposition"])?.trim().toLowerCase() ?? "";
  const detailRaw = readString(payload?.["detail"]);

  if (!contactId) {
    return teamMutationErrorResponse("invalid", "A contact is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { contactId: "Select the contact again." },
    });
  }
  if (!isDisposition(dispositionRaw)) {
    return teamMutationErrorResponse("invalid", "Choose a valid disposition.", {
      correlationId: mutation.correlationId,
      fieldErrors: {
        disposition: "Choose one of the listed outcomes.",
      },
    });
  }

  const disposition = dispositionRaw;
  const detail = detailRaw?.trim() || null;
  const markLost = shouldMarkLost(disposition);
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/sales/disposition",
      entityType: "contact",
      entityId: contactId,
      payload: { disposition, detail },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // One contact can only transition through this operator action once at
      // a time, even when two staff members submit different request keys.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
      const [contact] = await tx
        .select({
          id: contacts.id,
          doNotContact: contacts.doNotContact,
          doNotContactReason: contacts.doNotContactReason,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .for("update")
        .limit(1);
      if (!contact) {
        throw new TeamMutationFailure(
          "invalid",
          "The contact no longer exists.",
          {
            status: 404,
            fieldErrors: {
              contactId: "Refresh Sales HQ and choose another task.",
            },
          },
        );
      }

      const now = new Date();
      const title = `Disqualified: ${titleForDisposition(disposition)}`;
      const notes = [
        `disqualify=${disposition}`,
        "source=sales_disposition",
        detail ? `detail=${detail}` : null,
      ]
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        )
        .join(" ");

      const completedSpeedTasks = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.contactId, contactId),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%kind=speed_to_lead%"),
          ),
        )
        .returning({ id: crmTasks.id });

      const completedFollowupTasks = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.contactId, contactId),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%kind=follow_up%"),
          ),
        )
        .returning({ id: crmTasks.id });

      // Keep one canonical disposition task per contact. A second request
      // with a different key updates that record instead of duplicating CRM
      // history; the append-only audit log preserves each intentional change.
      const [existingDispositionTask] = await tx
        .select({
          id: crmTasks.id,
          title: crmTasks.title,
          notes: crmTasks.notes,
          status: crmTasks.status,
        })
        .from(crmTasks)
        .where(
          and(
            eq(crmTasks.contactId, contactId),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%source=sales_disposition%"),
          ),
        )
        .orderBy(desc(crmTasks.createdAt), desc(crmTasks.id))
        .for("update")
        .limit(1);

      const dispositionChanged =
        !existingDispositionTask ||
        existingDispositionTask.title !== title ||
        existingDispositionTask.notes !== notes ||
        existingDispositionTask.status !== "completed";
      const [dispositionTask] = !existingDispositionTask
        ? await tx
            .insert(crmTasks)
            .values({
              contactId,
              title,
              dueAt: null,
              assignedTo: mutation.actor.id,
              status: "completed",
              notes,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: crmTasks.id })
        : dispositionChanged
          ? await tx
              .update(crmTasks)
              .set({
                title,
                notes,
                assignedTo: mutation.actor.id,
                status: "completed",
                updatedAt: now,
              })
              .where(eq(crmTasks.id, existingDispositionTask.id))
              .returning({ id: crmTasks.id })
          : [{ id: existingDispositionTask.id }];
      if (!dispositionTask) {
        throw new TeamMutationFailure(
          "internal",
          "The disposition task could not be saved.",
          { retryable: true },
        );
      }

      const [existingPipeline] = await tx
        .select({ stage: crmPipeline.stage })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, contactId))
        .for("update")
        .limit(1);
      const pipelineChanged = markLost && existingPipeline?.stage !== "lost";
      if (pipelineChanged) {
        await tx
          .insert(crmPipeline)
          .values({
            contactId,
            stage: "lost",
            notes: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: crmPipeline.contactId,
            set: { stage: "lost", updatedAt: now },
          });
      }

      let dncChanged = false;
      if (disposition === "do_not_contact") {
        const dncReason = detail ?? "Marked Do Not Contact from Inbox.";
        dncChanged =
          contact.doNotContact !== true ||
          contact.doNotContactReason !== dncReason;
        await tx
          .update(contacts)
          .set({
            doNotContact: true,
            doNotContactAt: now,
            doNotContactBy: mutation.actor.id,
            doNotContactReason: dncReason,
            updatedAt: now,
          })
          .where(eq(contacts.id, contactId));

        const leadRows = await tx
          .select({ leadId: conversationThreads.leadId })
          .from(conversationThreads)
          .where(eq(conversationThreads.contactId, contactId))
          .limit(25);
        const leadIds = leadRows
          .map((row) => row.leadId)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          );
        if (leadIds.length) {
          await tx
            .update(leadAutomationStates)
            .set({ dnc: true, followupState: "stopped", updatedAt: now })
            .where(inArray(leadAutomationStates.leadId, leadIds));
        }
      }

      const completedTaskCount =
        completedSpeedTasks.length + completedFollowupTasks.length;
      const changed =
        dispositionChanged ||
        completedTaskCount > 0 ||
        pipelineChanged ||
        dncChanged;
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: contactId,
        before: {
          pipelineStage: existingPipeline?.stage ?? null,
          doNotContact: contact.doNotContact === true,
        },
        after: {
          disposition,
          pipelineStage: markLost ? "lost" : (existingPipeline?.stage ?? null),
          doNotContact:
            disposition === "do_not_contact"
              ? true
              : contact.doNotContact === true,
        },
        metadata: {
          detail,
          changed,
          markLost,
          completedTaskCount,
          dispositionTaskId: dispositionTask.id,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult<SalesDispositionData>(
        mutation,
        {
          contactId,
          disposition,
          changed,
          markLost,
          completedTaskCount,
          dispositionTaskId: dispositionTask.id,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "contact",
          entityId: contactId,
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
        console.error("[sales-disposition] idempotency_settlement_failed", {
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
