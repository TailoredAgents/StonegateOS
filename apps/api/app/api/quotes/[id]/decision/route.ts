import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  crmPipeline,
  getDb,
  leadAutomationStates,
  leads,
  outboxEvents,
  quotes,
} from "@/db";
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

const AdminDecisionSchema = z.object({
  decision: z.enum(["accepted", "declined"]),
  confirmation: z.literal("set_quote_decision"),
  notes: z.string().max(2000).optional(),
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.decision",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { id: rawId } = await context.params;
  const quoteId = rawId?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_quote_id" },
    });
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Select a valid quote." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "version_required" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The latest quote version is required before recording a decision.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }

  const parsedBody = AdminDecisionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "decision" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Choose and confirm a valid quote decision.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { decision: "Choose Approve or Reject." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes/:id/decision",
      entityType: "quote",
      entityId: quoteId,
      payload: parsedBody.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: quotes.id,
          contactId: quotes.contactId,
          status: quotes.status,
          sentAt: quotes.sentAt,
          revision: quotes.revision,
          decisionAt: quotes.decisionAt,
          decisionNotes: quotes.decisionNotes,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The quote was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, existing.revision);
      if (existing.status === "accepted" || existing.status === "declined") {
        throw new TeamMutationFailure(
          "conflict",
          existing.status === parsedBody.data.decision
            ? `This quote is already ${existing.status}.`
            : "This quote already has a final decision and cannot be changed here.",
        );
      }
      if (existing.status !== "sent" || !existing.sentAt) {
        throw new TeamMutationFailure(
          "conflict",
          "Send this quote before recording a staff decision. Unsent drafts remain editable and cannot be finalized here.",
        );
      }

      const decisionAt = new Date();
      const nextRevision = existing.revision + 1;
      const targetStage =
        parsedBody.data.decision === "accepted" ? "won" : "lost";
      const [existingPipeline] = await tx
        .select({ stage: crmPipeline.stage })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, existing.contactId))
        .limit(1);
      const [updated] = await tx
        .update(quotes)
        .set({
          status: parsedBody.data.decision,
          decisionAt,
          decisionNotes: parsedBody.data.notes ?? null,
          revision: nextRevision,
          updatedAt: decisionAt,
        })
        .where(
          and(eq(quotes.id, quoteId), eq(quotes.revision, existing.revision)),
        )
        .returning({
          id: quotes.id,
          status: quotes.status,
          revision: quotes.revision,
          decisionAt: quotes.decisionAt,
          decisionNotes: quotes.decisionNotes,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The quote changed while the decision was being recorded. Refresh and try again.",
          { retryable: true },
        );
      }

      await tx
        .insert(crmPipeline)
        .values({
          contactId: existing.contactId,
          stage: targetStage,
          updatedAt: decisionAt,
        })
        .onConflictDoUpdate({
          target: crmPipeline.contactId,
          set: { stage: targetStage, updatedAt: decisionAt },
        });

      const contactLeadIds = tx
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.contactId, existing.contactId));
      await tx
        .update(leadAutomationStates)
        .set({
          followupState: "stopped",
          followupStep: 0,
          nextFollowupAt: null,
          updatedAt: decisionAt,
        })
        .where(inArray(leadAutomationStates.leadId, contactLeadIds));
      await tx.delete(outboxEvents).where(
        and(
          eq(outboxEvents.type, "followup.send"),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
          sql`(${outboxEvents.payload}->>'leadId') IN (
              SELECT ${leads.id}::text
              FROM ${leads}
              WHERE ${leads.contactId} = ${existing.contactId}
            )`,
        ),
      );

      const [pipelineEvent] = await tx
        .insert(outboxEvents)
        .values({
          type: "pipeline.auto_stage_change",
          payload: {
            contactId: existing.contactId,
            fromStage: existingPipeline?.stage ?? null,
            toStage: targetStage,
            reason: "quote.decision.team",
            meta: {
              quoteId: updated.id,
              decision: parsedBody.data.decision,
            },
          },
        })
        .returning({ id: outboxEvents.id });
      if (!pipelineEvent?.id) {
        throw new TeamMutationFailure(
          "internal",
          "The quote decision could not record its linked pipeline evidence.",
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: updated.id,
        before: {
          status: existing.status,
          revision: existing.revision,
          decisionAt: existing.decisionAt?.toISOString() ?? null,
        },
        after: {
          status: updated.status,
          revision: updated.revision,
          decisionAt: updated.decisionAt?.toISOString() ?? null,
        },
        metadata: {
          pipelineEventId: pipelineEvent.id,
          pipelineStage: targetStage,
          hasDecisionNotes: Boolean(updated.decisionNotes),
          decisionSource: "team",
          customerNotificationQueued: false,
        },
        committedAt: decisionAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          quoteId: updated.id,
          status: updated.status,
          decisionAt: updated.decisionAt?.toISOString() ?? null,
          decisionNotes: updated.decisionNotes,
          revision: updated.revision,
          pipelineEventId: pipelineEvent.id,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "quote",
          entityId: updated.id,
          version: String(updated.revision),
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
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "mutation",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
