import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { contacts, crmPipeline, crmTasks, getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  executePipelineStageMutation,
  isPipelineContactId,
  parsePipelineExpectedVersion,
  parsePipelineStageMutationPayload,
  PIPELINE_MUTATION_MAXIMUM_BYTES,
  PipelineStageConflictFailure,
  runPipelineStageMutationAtomic,
  type PipelineStageMutationRepository,
  type PipelineStagePublicState,
} from "@/lib/pipeline-stage-mutation";
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
  teamMutationExceptionResult,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function boundedRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function pipelineConflictResponse(
  result: MutationResult<never> & { current: PipelineStagePublicState },
  correlationId: string,
): NextResponse {
  return NextResponse.json(result, {
    status: 409,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "x-correlation-id": correlationId,
    },
  });
}

function createRepository(
  tx: TeamMutationTransaction,
): PipelineStageMutationRepository {
  return {
    async lockContactScope(contactId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
      );
    },
    async findActiveContactForUpdate(contactId) {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
        .for("update")
        .limit(1);
      return Boolean(contact?.id);
    },
    async findPipelineForUpdate(contactId) {
      const [pipeline] = await tx
        .select({
          contactId: crmPipeline.contactId,
          stage: crmPipeline.stage,
          notes: crmPipeline.notes,
          createdAt: crmPipeline.createdAt,
          updatedAt: crmPipeline.updatedAt,
        })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, contactId))
        .for("update")
        .limit(1);
      return pipeline ?? null;
    },
    async insertPipeline(input) {
      const [pipeline] = await tx
        .insert(crmPipeline)
        .values({
          contactId: input.contactId,
          stage: input.stage,
          notes: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({ target: crmPipeline.contactId })
        .returning({
          contactId: crmPipeline.contactId,
          stage: crmPipeline.stage,
          notes: crmPipeline.notes,
          createdAt: crmPipeline.createdAt,
          updatedAt: crmPipeline.updatedAt,
        });
      return pipeline ?? null;
    },
    async updatePipeline(input) {
      const [pipeline] = await tx
        .update(crmPipeline)
        .set({ stage: input.stage, updatedAt: input.updatedAt })
        .where(
          and(
            eq(crmPipeline.contactId, input.contactId),
            eq(crmPipeline.updatedAt, input.previousUpdatedAt),
          ),
        )
        .returning({
          contactId: crmPipeline.contactId,
          stage: crmPipeline.stage,
          notes: crmPipeline.notes,
          createdAt: crmPipeline.createdAt,
          updatedAt: crmPipeline.updatedAt,
        });
      return pipeline ?? null;
    },
    async insertNote(input) {
      const [note] = await tx
        .insert(crmTasks)
        .values({
          contactId: input.contactId,
          title: "Note",
          status: "completed",
          notes: input.notes,
          dueAt: null,
          assignedTo: null,
        })
        .returning({ id: crmTasks.id });
      return note?.id ?? null;
    },
    async closeSalesHqTasks(input) {
      const closed = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: input.updatedAt })
        .where(
          and(
            eq(crmTasks.contactId, input.contactId),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            or(
              ilike(crmTasks.notes, "%kind=speed_to_lead%"),
              ilike(crmTasks.notes, "%kind=follow_up%"),
            ),
          ),
        )
        .returning({ id: crmTasks.id });
      return closed.length;
    },
  };
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["pipeline.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "pipeline.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Params and request bytes are deliberately untouched until authorization,
  // principal type, same-origin, idempotency, and version headers pass.
  if (request.nextUrl.search.length > 0) {
    return teamMutationResultResponse(
      {
        ok: false,
        code: "invalid",
        message: "Pipeline stage updates do not accept query parameters.",
        retryable: false,
        fieldErrors: { request: "Remove unsupported URL controls." },
      },
      422,
      mutation.correlationId,
    );
  }
  const { contactId: rawContactId } = await context.params;
  const contactId = rawContactId?.normalize("NFKC").trim() ?? "";
  if (!isPipelineContactId(contactId)) {
    return teamMutationResultResponse(
      {
        ok: false,
        code: "invalid",
        message: "Choose a valid contact before changing its pipeline stage.",
        retryable: false,
        fieldErrors: { contactId: "Select a valid active contact." },
      },
      422,
      mutation.correlationId,
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const expectedVersion = parsePipelineExpectedVersion(
      mutation.expectedVersion,
    );
    let rawPayload: unknown;
    try {
      rawPayload = await readBoundedJsonRequest(request, {
        maximumBytes: PIPELINE_MUTATION_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const payload = parsePipelineStageMutationPayload(rawPayload);

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "PATCH /api/admin/crm/pipeline/:contactId",
      entityType: "crm_pipeline",
      entityId: contactId,
      payload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await runPipelineStageMutationAtomic(
      (work) => database.transaction(work),
      async (tx) => {
        let execution;
        try {
          execution = await executePipelineStageMutation(createRepository(tx), {
            contactId,
            expectedVersion,
            payload,
          });
        } catch (error) {
          if (error instanceof PipelineStageConflictFailure) {
            const failure = teamMutationExceptionResult(error);
            const conflictResult = {
              ...failure.result,
              current: error.current,
            } satisfies MutationResult<never> & {
              current: PipelineStagePublicState;
            };
            // Persist the exact safe current state. If the 409 response is
            // lost, the same key replays this complete reconciliation payload
            // rather than degrading to a generic conflict.
            await completeTeamMutationIdempotency(
              tx,
              mutation,
              claimed.claim,
              conflictResult,
              409,
            );
            return { kind: "conflict" as const, result: conflictResult };
          }
          throw error;
        }
        const committedAt = new Date();
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "crm_pipeline",
          entityId: contactId,
          before: execution.before,
          after: execution.pipeline,
          metadata: {
            contactId,
            fromStage: execution.before.stage,
            stage: execution.pipeline.stage,
            noOp: execution.noOp,
            noteAdded: execution.noteTaskId !== null,
            noteTaskId: execution.noteTaskId,
            closedSalesTaskCount: execution.closedSalesTaskCount,
          },
          committedAt,
        });
        const data = {
          pipeline: execution.pipeline,
          noteTaskId: execution.noteTaskId,
          closedSalesTaskCount: execution.closedSalesTaskCount,
          noOp: execution.noOp,
        };
        const mutationResult = teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "crm_pipeline",
          entityId: contactId,
          version: execution.pipeline.version,
        });
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          mutationResult,
          200,
        );
        return { kind: "success" as const, result: mutationResult };
      },
    );

    if (result.kind === "conflict") {
      return pipelineConflictResponse(result.result, mutation.correlationId);
    }
    return teamMutationResultResponse(
      result.result,
      200,
      mutation.correlationId,
      {
        "Cache-Control": "private, no-store, max-age=0",
      },
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[pipeline-stage] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    if (error instanceof PipelineStageConflictFailure) {
      const failure = teamMutationExceptionResult(error);
      return pipelineConflictResponse(
        { ...failure.result, current: error.current },
        mutation.correlationId,
      );
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
