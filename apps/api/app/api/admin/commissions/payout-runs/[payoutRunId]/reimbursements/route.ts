import { createHash } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { expenses, getDb, payoutRunAdjustments, payoutRuns } from "@/db";
import {
  nextPayoutRunVersionDate,
  payoutRunVersion,
  requirePayoutRunExpectedVersion,
} from "@/lib/commissions";
import { normalizePayoutRunMutationError } from "@/lib/payout-run-mutation-http";
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
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const MAX_BYTES = 10 * 1024 * 1024;

const CreateReimbursementSchema = z.object({
  memberId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  note: z.string().trim().min(1).max(2_000),
  vendor: z.string().trim().max(240).optional().nullable(),
  paidAt: z.string().datetime(),
  receiptFilename: z.string().trim().max(240).optional().nullable(),
  receiptUrl: z.string().trim().max(15_000_000).optional().nullable(),
  receiptContentType: z.string().trim().max(120).optional().nullable(),
});

const DeleteReimbursementSchema = z.object({
  adjustmentId: z.string().uuid(),
});

type ParsedReimbursement = z.infer<typeof CreateReimbursementSchema> & {
  receiptSha256: string | null;
};

type ReimbursementMutationData = {
  payoutRunId: string;
  adjustmentId: string;
  expenseId: string | null;
  version: string;
};

type ReimbursementMutationSuccess = Extract<
  MutationResult<ReimbursementMutationData>,
  { ok: true }
> &
  ReimbursementMutationData;

function dataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const base64Part = dataUrl.split(",")[1] ?? "";
  return Math.ceil((base64Part.length * 3) / 4);
}

function dataUrlSha256(dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null;
  return createHash("sha256").update(dataUrl, "utf8").digest("hex");
}

async function parseCreatePayload(
  request: NextRequest,
): Promise<ParsedReimbursement> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const amountCentsRaw = form.get("amountCents");
    const amountCents =
      typeof amountCentsRaw === "string" ? Number(amountCentsRaw) : NaN;
    const file = form.get("receiptFile");
    const filenameField = form.get("receiptFilename");
    const vendorField = form.get("vendor");

    let receiptUrl: string | null = null;
    let receiptFilename: string | null = null;
    let receiptContentType: string | null = null;
    let receiptSha256: string | null = null;
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) {
        throw new TeamMutationFailure(
          "invalid",
          "Receipt files must be 10MB or smaller.",
          {
            status: 413,
            fieldErrors: { receiptFile: "Maximum size is 10MB." },
          },
        );
      }
      receiptContentType = file.type || "application/octet-stream";
      receiptUrl = `data:${receiptContentType};base64,${buffer.toString("base64")}`;
      receiptFilename =
        typeof filenameField === "string" && filenameField.trim().length > 0
          ? filenameField.trim()
          : file.name || "receipt";
      receiptSha256 = createHash("sha256").update(buffer).digest("hex");
    }

    const parsed = CreateReimbursementSchema.safeParse({
      memberId: form.get("memberId"),
      amountCents: Math.round(amountCents),
      note: form.get("note"),
      vendor:
        typeof vendorField === "string" && vendorField.trim().length > 0
          ? vendorField.trim()
          : null,
      paidAt: form.get("paidAt"),
      receiptFilename,
      receiptUrl,
      receiptContentType,
    });
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "The reimbursement details are invalid.",
        { fieldErrors: { reimbursement: "Review the submitted fields." } },
      );
    }
    return { ...parsed.data, receiptSha256 };
  }

  const parsed = CreateReimbursementSchema.safeParse(
    (await request.json().catch(() => null)) as unknown,
  );
  if (!parsed.success) {
    throw new TeamMutationFailure(
      "invalid",
      "The reimbursement details are invalid.",
      { fieldErrors: { reimbursement: "Review the submitted fields." } },
    );
  }
  const bytes = parsed.data.receiptUrl
    ? dataUrlBytes(parsed.data.receiptUrl)
    : null;
  if (bytes !== null && bytes > MAX_BYTES) {
    throw new TeamMutationFailure(
      "invalid",
      "Receipt files must be 10MB or smaller.",
      { status: 413, fieldErrors: { receiptFile: "Maximum size is 10MB." } },
    );
  }
  return {
    ...parsed.data,
    receiptSha256: dataUrlSha256(parsed.data.receiptUrl),
  };
}

async function lockEditableRun(
  tx: TeamMutationTransaction,
  payoutRunId: string,
  mutation: TeamMutationContext,
) {
  const [run] = await tx
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
      updatedAt: payoutRuns.updatedAt,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, payoutRunId))
    .limit(1)
    .for("update");
  if (!run) throw new Error("payout_run_not_found");
  if (run.status !== "draft") throw new Error("payout_run_not_editable");
  assertTeamMutationExpectedVersion(mutation, payoutRunVersion(run.updatedAt));
  return run;
}

async function completeReimbursementMutation(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  data: ReimbursementMutationData,
  input: {
    action: "created" | "deleted";
    memberId: string | null;
    amountCents: number | null;
    receiptSha256?: string | null;
  },
  status: number,
): Promise<ReimbursementMutationSuccess> {
  const audit = await mutation.audit.insertSuccess(tx, {
    entityType: "payout_run_adjustment",
    entityId: data.adjustmentId,
    after:
      input.action === "created"
        ? {
            payoutRunId: data.payoutRunId,
            memberId: input.memberId,
            amountCents: input.amountCents,
            version: data.version,
          }
        : null,
    before:
      input.action === "deleted"
        ? {
            payoutRunId: data.payoutRunId,
            memberId: input.memberId,
            amountCents: input.amountCents,
          }
        : null,
    metadata: {
      payoutRunId: data.payoutRunId,
      expenseId: data.expenseId,
      receiptSha256: input.receiptSha256 ?? null,
      resultingPayoutRunVersion: data.version,
    },
  });
  const baseResult = teamMutationSuccessResult(mutation, data, {
    auditEventId: audit.auditEventId,
    committedAt: audit.committedAt,
    entityType: "payout_run_adjustment",
    entityId: data.adjustmentId,
    version: data.version,
  });
  const result = Object.assign(
    baseResult,
    data,
  ) as ReimbursementMutationSuccess;
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return result;
}

async function settleFailure(
  db: ReturnType<typeof getDb> | null,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim | null,
  error: TeamMutationFailure,
  action: "create" | "delete",
): Promise<void> {
  if (!db || !claim) return;
  try {
    await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
  } catch (settlementError) {
    console.error(
      `[commissions] reimbursement_${action}_idempotency_settlement_failed`,
      {
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        errorName:
          settlementError instanceof Error
            ? settlementError.name
            : "UnknownError",
      },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["commissions.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "commission.payout_run.reimbursement.created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    requirePayoutRunExpectedVersion(mutation);
    const { payoutRunId } = await context.params;
    if (!payoutRunId) {
      throw new TeamMutationFailure("invalid", "Payout run ID is required.");
    }
    const payload = await parseCreatePayload(request);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/commissions/payout-runs/:id/reimbursements",
      entityType: "payout_run",
      entityId: payoutRunId,
      payload: {
        memberId: payload.memberId,
        amountCents: payload.amountCents,
        note: payload.note,
        vendor: payload.vendor ?? null,
        paidAt: payload.paidAt,
        receiptFilename: payload.receiptFilename ?? null,
        receiptContentType: payload.receiptContentType ?? null,
        receiptSha256: payload.receiptSha256,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const executionClaim = claimed.claim;
    claim = executionClaim;

    const paidAt = new Date(payload.paidAt);
    const result = await db.transaction(async (tx) => {
      const run = await lockEditableRun(tx, payoutRunId, mutation);
      const now = new Date();
      const nextVersion = nextPayoutRunVersionDate(run.updatedAt, now);
      const [createdExpense] = await tx
        .insert(expenses)
        .values({
          amount: payload.amountCents,
          currency: "USD",
          category: "Reimbursements",
          vendor: payload.vendor ?? null,
          memo: payload.note,
          method: "reimbursement",
          source: "payout_reimbursement",
          paidAt,
          receiptFilename: payload.receiptFilename ?? null,
          receiptUrl: payload.receiptUrl ?? null,
          receiptContentType: payload.receiptContentType ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: expenses.id });
      if (!createdExpense) {
        throw new TeamMutationFailure(
          "internal",
          "The reimbursement expense could not be created.",
          { retryable: true },
        );
      }

      const [createdAdjustment] = await tx
        .insert(payoutRunAdjustments)
        .values({
          payoutRunId,
          memberId: payload.memberId,
          kind: "reimbursement",
          amountCents: payload.amountCents,
          note: payload.note,
          expenseId: createdExpense.id,
          createdBy: mutation.actor.id,
          createdAt: now,
        })
        .returning({ id: payoutRunAdjustments.id });
      if (!createdAdjustment) {
        throw new TeamMutationFailure(
          "internal",
          "The reimbursement adjustment could not be created.",
          { retryable: true },
        );
      }

      const [updatedRun] = await tx
        .update(payoutRuns)
        .set({
          updatedAt: nextVersion,
          reportHtml: null,
          reportGeneratedAt: null,
        })
        .where(
          and(eq(payoutRuns.id, payoutRunId), eq(payoutRuns.status, "draft")),
        )
        .returning({ updatedAt: payoutRuns.updatedAt });
      if (!updatedRun) throw new Error("payout_run_state_conflict");

      return completeReimbursementMutation(
        tx,
        mutation,
        executionClaim,
        {
          payoutRunId,
          adjustmentId: createdAdjustment.id,
          expenseId: createdExpense.id,
          version: payoutRunVersion(updatedRun.updatedAt),
        },
        {
          action: "created",
          memberId: payload.memberId,
          amountCents: payload.amountCents,
          receiptSha256: payload.receiptSha256,
        },
        201,
      );
    });

    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (rawError) {
    const error = normalizePayoutRunMutationError(rawError);
    await settleFailure(db, mutation, claim, error, "create");
    return teamMutationExceptionResponse(error, mutation);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["commissions.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "commission.payout_run.reimbursement.deleted",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    requirePayoutRunExpectedVersion(mutation);
    const { payoutRunId } = await context.params;
    if (!payoutRunId) {
      throw new TeamMutationFailure("invalid", "Payout run ID is required.");
    }
    const payload = DeleteReimbursementSchema.safeParse(
      (await request.json().catch(() => null)) as unknown,
    );
    if (!payload.success) {
      throw new TeamMutationFailure(
        "invalid",
        "A valid reimbursement ID is required.",
      );
    }

    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/admin/commissions/payout-runs/:id/reimbursements",
      entityType: "payout_run_adjustment",
      entityId: payload.data.adjustmentId,
      payload: { payoutRunId },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    const executionClaim = claimed.claim;
    claim = executionClaim;

    const result = await db.transaction(async (tx) => {
      const run = await lockEditableRun(tx, payoutRunId, mutation);
      const [adjustment] = await tx
        .select({
          id: payoutRunAdjustments.id,
          kind: payoutRunAdjustments.kind,
          amountCents: payoutRunAdjustments.amountCents,
          memberId: payoutRunAdjustments.memberId,
          expenseId: payoutRunAdjustments.expenseId,
        })
        .from(payoutRunAdjustments)
        .where(
          and(
            eq(payoutRunAdjustments.id, payload.data.adjustmentId),
            eq(payoutRunAdjustments.payoutRunId, payoutRunId),
          ),
        )
        .limit(1);
      if (!adjustment) throw new Error("adjustment_not_found");
      if (adjustment.kind !== "reimbursement") {
        throw new Error("adjustment_not_reimbursement");
      }

      await tx
        .delete(payoutRunAdjustments)
        .where(eq(payoutRunAdjustments.id, adjustment.id));
      if (adjustment.expenseId) {
        await tx
          .delete(expenses)
          .where(
            and(
              eq(expenses.id, adjustment.expenseId),
              eq(expenses.source, "payout_reimbursement"),
            ),
          );
      }

      const nextVersion = nextPayoutRunVersionDate(run.updatedAt);
      const [updatedRun] = await tx
        .update(payoutRuns)
        .set({
          updatedAt: nextVersion,
          reportHtml: null,
          reportGeneratedAt: null,
        })
        .where(
          and(eq(payoutRuns.id, payoutRunId), eq(payoutRuns.status, "draft")),
        )
        .returning({ updatedAt: payoutRuns.updatedAt });
      if (!updatedRun) throw new Error("payout_run_state_conflict");

      return completeReimbursementMutation(
        tx,
        mutation,
        executionClaim,
        {
          payoutRunId,
          adjustmentId: adjustment.id,
          expenseId: adjustment.expenseId,
          version: payoutRunVersion(updatedRun.updatedAt),
        },
        {
          action: "deleted",
          memberId: adjustment.memberId,
          amountCents: adjustment.amountCents,
        },
        200,
      );
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (rawError) {
    const error = normalizePayoutRunMutationError(rawError);
    await settleFailure(db, mutation, claim, error, "delete");
    return teamMutationExceptionResponse(error, mutation);
  }
}
