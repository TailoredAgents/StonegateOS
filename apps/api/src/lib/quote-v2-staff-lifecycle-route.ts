import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { ensureQuoteAcceptanceCertificate } from "@/lib/quote-v2-acceptance-certificate";
import {
  QuoteV2ArchiveCommandSchema,
  QuoteV2ChangeResolutionCommandSchema,
  QuoteV2StaffDecisionCommandSchema,
  QuoteV2VoidCommandSchema,
} from "@/lib/quote-v2-contract";
import {
  archiveQuoteV2,
  recordQuoteV2StaffDecision,
  resolveQuoteV2ChangeRequest,
  voidQuoteV2,
  type QuoteV2ArchiveCommand,
  type QuoteV2ChangeResolutionCommand,
  type QuoteV2StaffDecisionCommand,
  type QuoteV2VoidCommand,
} from "@/lib/quote-v2-staff-lifecycle";
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
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
  type TeamMutationSuccessAuditInput,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type VersionedCommand = {
  quoteRevision: number;
  notifyCustomer?: boolean;
};
type VersionedReceipt = { quoteRevision: number };

type LifecycleRouteConfig<
  Command extends VersionedCommand,
  Receipt extends VersionedReceipt,
> = {
  request: NextRequest;
  resourceId: string;
  resourceName: string;
  additionalResources?: readonly {
    id: string;
    name: string;
    field: string;
  }[];
  routeScope: string;
  entityType: string;
  auditAction: string;
  schema: z.ZodType<Command, z.ZodTypeDef, unknown>;
  validateCommand?: (
    command: Command,
  ) => { field: string; message: string } | null;
  execute: (input: {
    tx: TeamMutationTransaction;
    command: Command;
    mutation: TeamMutationContext;
    actorTeamMemberId: string;
    idempotencyKeyHash: string;
  }) => Promise<Receipt>;
  audit: (receipt: Receipt, command: Command) => TeamMutationSuccessAuditInput;
  receiptEntity: (receipt: Receipt) => {
    entityType: string;
    entityId: string;
  };
  afterCommit?: (
    db: ReturnType<typeof getDb>,
    receipt: Receipt,
    mutation: TeamMutationContext,
  ) => Promise<void>;
  repairReplay?: (
    db: ReturnType<typeof getDb>,
    result: MutationResult<unknown>,
    mutation: TeamMutationContext,
  ) => Promise<void>;
};

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    fieldErrors[issue.path.join(".") || "request"] ??= issue.message;
  }
  return fieldErrors;
}

function logRepairFailure(input: {
  action: string;
  correlationId: string;
  error: unknown;
}): void {
  console.warn("[quote-v2-lifecycle] derived evidence repair failed", {
    action: input.action,
    correlationId: input.correlationId,
    error: input.error instanceof Error ? input.error.name : "unknown",
  });
}

async function runLifecycleRoute<
  Command extends VersionedCommand,
  Receipt extends VersionedReceipt,
>(config: LifecycleRouteConfig<Command, Receipt>): Promise<Response> {
  const boundary = await beginTeamMutation(config.request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: config.auditAction,
  });
  if (!boundary.ok) return boundary.response;
  let { mutation } = boundary;
  const invalidResource = [
    {
      id: config.resourceId,
      name: config.resourceName,
      field: "id",
    },
    ...(config.additionalResources ?? []),
  ].find((resource) => !UUID_PATTERN.test(resource.id));
  if (invalidResource) {
    await recordTeamMutationFailure(mutation, {
      entityType: config.entityType,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_resource_id" },
    });
    return teamMutationErrorResponse(
      "invalid",
      `A valid ${invalidResource.name} is required.`,
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          [invalidResource.field]: `Open a valid ${invalidResource.name} and try again.`,
        },
      },
    );
  }
  if (!isQuoteV2FeatureEnabled("staff")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = config.schema.safeParse(
    await config.request.json().catch(() => null),
  );
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: config.entityType,
      entityId: config.resourceId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_command" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Review and confirm the quote lifecycle action.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: zodFieldErrors(parsed.error),
      },
    );
  }
  const bindingError = config.validateCommand?.(parsed.data) ?? null;
  if (bindingError) {
    await recordTeamMutationFailure(mutation, {
      entityType: config.entityType,
      entityId: config.resourceId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "route_body_mismatch" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The submitted quote action does not match the opened record.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { [bindingError.field]: bindingError.message },
      },
    );
  }
  if (parsed.data.notifyCustomer === true) {
    const notificationBoundary = await beginTeamMutation(config.request, {
      principalTypes: ["human"],
      requiredPermissions: ["quotes.update", "quotes.send"],
      risk: "external",
      requiresIdempotency: true,
      auditAction: config.auditAction,
    });
    if (!notificationBoundary.ok) return notificationBoundary.response;
    mutation = notificationBoundary.mutation;
  }
  const expectedQuoteRevision = Number(mutation.expectedVersion);
  if (
    !Number.isSafeInteger(expectedQuoteRevision) ||
    expectedQuoteRevision <= 0 ||
    expectedQuoteRevision !== parsed.data.quoteRevision
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current quote revision is required for this action.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId || !mutation.idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team action is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: config.routeScope,
      entityType: config.entityType,
      entityId: config.resourceId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      if (config.repairReplay) {
        await config
          .repairReplay(db, claimed.replay.result, mutation)
          .catch((error) =>
            logRepairFailure({
              action: config.auditAction,
              correlationId: mutation.correlationId,
              error,
            }),
          );
      }
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await config.execute({
        tx,
        command: parsed.data,
        mutation,
        actorTeamMemberId,
        idempotencyKeyHash: mutation.idempotencyKeyHash!,
      });
      const audit = await mutation.audit.insertSuccess(
        tx,
        config.audit(receipt, parsed.data),
      );
      const receiptEntity = config.receiptEntity(receipt);
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: receiptEntity.entityType,
        entityId: receiptEntity.entityId,
        version: String(receipt.quoteRevision),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    if (config.afterCommit) {
      await config.afterCommit(db, result.data, mutation).catch((error) =>
        logRepairFailure({
          action: config.auditAction,
          correlationId: mutation.correlationId,
          error,
        }),
      );
    }
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
      entityType: config.entityType,
      entityId: config.resourceId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "v2_staff_lifecycle",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}

function acceptedReplayEvidence(
  db: ReturnType<typeof getDb>,
  result: MutationResult<unknown>,
  mutation: TeamMutationContext,
): Promise<void> {
  if (!result.ok || !result.data || typeof result.data !== "object") {
    return Promise.resolve();
  }
  const data = result.data as Record<string, unknown>;
  if (
    data["decision"] !== "accepted" ||
    typeof data["responseId"] !== "string" ||
    !UUID_PATTERN.test(data["responseId"])
  ) {
    return Promise.resolve();
  }
  return ensureQuoteAcceptanceCertificate(db, {
    responseId: data["responseId"],
    correlationId: mutation.correlationId,
  }).then(() => undefined);
}

export async function handleQuoteV2StaffDecision(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const quoteId = (await context.params).id?.trim() ?? "";
  return runLifecycleRoute<
    QuoteV2StaffDecisionCommand,
    Awaited<ReturnType<typeof recordQuoteV2StaffDecision>>
  >({
    request,
    resourceId: quoteId,
    resourceName: "quote",
    routeScope: "POST /api/quotes/:id/decisions",
    entityType: "quote",
    auditAction: "quote.v2.staff_decision_recorded",
    schema: QuoteV2StaffDecisionCommandSchema,
    validateCommand: (command) =>
      command.quoteId === quoteId
        ? null
        : {
            field: "quoteId",
            message: "Use the quote that is open in the workspace.",
          },
    execute: ({
      tx,
      command,
      mutation,
      actorTeamMemberId,
      idempotencyKeyHash,
    }) =>
      recordQuoteV2StaffDecision(tx, {
        versionId: command.versionId,
        command,
        expectedQuoteRevision: command.quoteRevision,
        actorTeamMemberId,
        idempotencyKeyHash,
        correlationId: mutation.correlationId,
      }),
    audit: (receipt, command) => ({
      entityType: "quote_response",
      entityId: receipt.responseId,
      before: {
        quoteState: "open",
        versionState: "issued",
        quoteRevision: command.quoteRevision,
      },
      after: {
        quoteState: receipt.decision,
        versionState: receipt.decision,
        quoteRevision: receipt.quoteRevision,
      },
      metadata: {
        quoteId: receipt.quoteId,
        versionId: receipt.versionId,
        responseId: receipt.responseId,
        interactionSource: command.source,
        outboxEventId: receipt.outboxEventId,
        customerNotificationRequested: command.notifyCustomer,
        notificationMessageId: receipt.notificationMessageId,
      },
    }),
    receiptEntity: (receipt) => ({
      entityType: "quote_response",
      entityId: receipt.responseId,
    }),
    afterCommit: async (db, receipt, mutation) => {
      if (receipt.decision !== "accepted") return;
      await ensureQuoteAcceptanceCertificate(db, {
        responseId: receipt.responseId,
        correlationId: mutation.correlationId,
      });
    },
    repairReplay: acceptedReplayEvidence,
  });
}

export async function handleQuoteV2ChangeResolution(
  request: NextRequest,
  context: { params: Promise<{ id?: string; requestId?: string }> },
): Promise<Response> {
  const params = await context.params;
  const quoteId = params.id?.trim() ?? "";
  const changeRequestId = params.requestId?.trim() ?? "";
  return runLifecycleRoute<
    QuoteV2ChangeResolutionCommand,
    Awaited<ReturnType<typeof resolveQuoteV2ChangeRequest>>
  >({
    request,
    resourceId: changeRequestId,
    resourceName: "change request",
    additionalResources: [{ id: quoteId, name: "quote", field: "quoteId" }],
    routeScope: "POST /api/quotes/:id/change-requests/:requestId/resolve",
    entityType: "quote_change_request",
    auditAction: "quote.v2.change_request_resolved",
    schema: QuoteV2ChangeResolutionCommandSchema,
    validateCommand: (command) =>
      command.quoteId === quoteId
        ? null
        : {
            field: "quoteId",
            message: "Use the quote that owns this change request.",
          },
    execute: ({ tx, command, mutation, actorTeamMemberId }) =>
      resolveQuoteV2ChangeRequest(tx, {
        changeRequestId,
        command,
        expectedQuoteRevision: command.quoteRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      }),
    audit: (receipt, command) => ({
      entityType: "quote_change_request",
      entityId: receipt.changeRequestId,
      before: { status: "open_or_acknowledged" },
      after: {
        status: "resolved",
        resolution: receipt.resolution,
        quoteRevision: receipt.quoteRevision,
      },
      metadata: {
        quoteId: receipt.quoteId,
        sourceVersionId: receipt.sourceVersionId,
        resultingVersionId: receipt.resultingVersionId,
        customerNotificationRequested: command.notifyCustomer,
        notificationMessageId: receipt.notificationMessageId,
      },
    }),
    receiptEntity: (receipt) => ({
      entityType: "quote_change_request",
      entityId: receipt.changeRequestId,
    }),
  });
}

export async function handleQuoteV2Void(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const quoteId = (await context.params).id?.trim() ?? "";
  return runLifecycleRoute<
    QuoteV2VoidCommand,
    Awaited<ReturnType<typeof voidQuoteV2>>
  >({
    request,
    resourceId: quoteId,
    resourceName: "quote",
    routeScope: "POST /api/quotes/:id/void",
    entityType: "quote",
    auditAction: "quote.v2.voided",
    schema: QuoteV2VoidCommandSchema,
    execute: ({ tx, command, mutation, actorTeamMemberId }) =>
      voidQuoteV2(tx, {
        quoteId,
        command,
        expectedQuoteRevision: command.quoteRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      }),
    audit: (receipt, command) => ({
      entityType: "quote",
      entityId: receipt.quoteId,
      before: { state: "draft_or_open", quoteRevision: command.quoteRevision },
      after: { state: receipt.state, quoteRevision: receipt.quoteRevision },
      metadata: {
        versionId: receipt.versionId,
        dismissedChangeRequestCount: receipt.dismissedChangeRequestCount,
        customerNotificationRequested: command.notifyCustomer,
        notificationMessageId: receipt.notificationMessageId,
      },
    }),
    receiptEntity: (receipt) => ({
      entityType: "quote",
      entityId: receipt.quoteId,
    }),
  });
}

export async function handleQuoteV2Archive(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const quoteId = (await context.params).id?.trim() ?? "";
  return runLifecycleRoute<
    QuoteV2ArchiveCommand,
    Awaited<ReturnType<typeof archiveQuoteV2>>
  >({
    request,
    resourceId: quoteId,
    resourceName: "quote",
    routeScope: "POST /api/quotes/:id/archive",
    entityType: "quote",
    auditAction: "quote.v2.archived",
    schema: QuoteV2ArchiveCommandSchema,
    execute: ({ tx, command, mutation, actorTeamMemberId }) =>
      archiveQuoteV2(tx, {
        quoteId,
        command,
        expectedQuoteRevision: command.quoteRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      }),
    audit: (receipt, command) => ({
      entityType: "quote",
      entityId: receipt.quoteId,
      before: {
        state: "non_archived",
        quoteRevision: command.quoteRevision,
      },
      after: { state: receipt.state, quoteRevision: receipt.quoteRevision },
      metadata: {
        versionId: receipt.versionId,
        dismissedChangeRequestCount: receipt.dismissedChangeRequestCount,
        customerNotificationRequested: command.notifyCustomer,
        notificationMessageId: receipt.notificationMessageId,
      },
    }),
    receiptEntity: (receipt) => ({
      entityType: "quote",
      entityId: receipt.quoteId,
    }),
  });
}
