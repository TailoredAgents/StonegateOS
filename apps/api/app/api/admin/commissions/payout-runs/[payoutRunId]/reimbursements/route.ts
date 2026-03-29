import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  expenses,
  getDb,
  payoutRunAdjustments,
  payoutRuns,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { savePayoutRunReportHtml } from "@/lib/payout-run-report";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

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

function parseDataUrlToBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const base64Part = dataUrl.split(",")[1] ?? "";
  return Math.ceil((base64Part.length * 3) / 4);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function ensureDraftPayoutRun(
  db: ReturnType<typeof getDb>,
  payoutRunId: string,
): Promise<void> {
  const [run] = await db
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, payoutRunId))
    .limit(1);

  if (!run?.id) {
    throw new Error("payout_run_not_found");
  }
  if (run.status !== "draft") {
    throw new Error("payout_run_not_editable");
  }
}

async function saveDraftRunReport(
  db: ReturnType<typeof getDb>,
  payoutRunId: string,
): Promise<void> {
  await savePayoutRunReportHtml(db, payoutRunId);
}

function responseForEditError(error: unknown): Response | null {
  const message = (error as Error).message;
  if (message === "payout_run_not_found") {
    return NextResponse.json({ error: "payout_run_not_found" }, { status: 404 });
  }
  if (message === "payout_run_not_editable") {
    return NextResponse.json(
      {
        error: "payout_run_not_editable",
        message: "Only draft payout runs can be edited.",
      },
      { status: 409 },
    );
  }
  if (message === "adjustment_not_found") {
    return NextResponse.json({ error: "adjustment_not_found" }, { status: 404 });
  }
  if (message === "adjustment_not_reimbursement") {
    return NextResponse.json(
      { error: "adjustment_not_reimbursement" },
      { status: 400 },
    );
  }
  return null;
}

async function parseCreatePayload(
  request: NextRequest,
): Promise<z.infer<typeof CreateReimbursementSchema> | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const amountCentsRaw = form.get("amountCents");
    const amountCents =
      typeof amountCentsRaw === "string" ? Number(amountCentsRaw) : NaN;
    if (!Number.isFinite(amountCents)) {
      return null;
    }

    const file = form.get("receiptFile");
    const filenameField = form.get("receiptFilename");
    const note = form.get("note");
    const memberId = form.get("memberId");
    const vendor = form.get("vendor");
    const paidAt = form.get("paidAt");

    let receiptUrl: string | null = null;
    let receiptFilename: string | null = null;
    let receiptContentType: string | null = null;

    if (file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        throw new Error("file_too_large");
      }
      receiptContentType = file.type || "application/octet-stream";
      receiptUrl = `data:${receiptContentType};base64,${buf.toString("base64")}`;
      receiptFilename =
        typeof filenameField === "string" && filenameField.trim().length > 0
          ? filenameField.trim()
          : file.name || "receipt";
    }

    const parsed = CreateReimbursementSchema.safeParse({
      memberId,
      amountCents: Math.round(amountCents),
      note,
      vendor:
        typeof vendor === "string" && vendor.trim().length > 0
          ? vendor.trim()
          : null,
      paidAt,
      receiptFilename,
      receiptUrl,
      receiptContentType,
    });

    return parsed.success ? parsed.data : null;
  }

  const json = (await request.json().catch(() => null)) as unknown;
  const parsed = CreateReimbursementSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    return NextResponse.json({ error: "missing_payout_run_id" }, { status: 400 });
  }

  let payload: z.infer<typeof CreateReimbursementSchema> | null;
  try {
    payload = await parseCreatePayload(request);
  } catch (error) {
    if ((error as Error).message === "file_too_large") {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    throw error;
  }

  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (payload.receiptUrl) {
    const bytes = parseDataUrlToBytes(payload.receiptUrl);
    if (bytes !== null && bytes > MAX_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
  }

  const paidAt = new Date(payload.paidAt);
  if (Number.isNaN(paidAt.getTime())) {
    return NextResponse.json({ error: "invalid_paid_at" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  let adjustmentId: string | null = null;
  let expenseId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await ensureDraftPayoutRun(tx as ReturnType<typeof getDb>, payoutRunId);

      const now = new Date();
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

      const [createdAdjustment] = await tx
        .insert(payoutRunAdjustments)
        .values({
          payoutRunId,
          memberId: payload.memberId,
          kind: "reimbursement",
          amountCents: payload.amountCents,
          note: payload.note,
          expenseId: createdExpense?.id ?? null,
          createdBy: actor.id ?? null,
          createdAt: now,
        })
        .returning({ id: payoutRunAdjustments.id });

      adjustmentId = createdAdjustment?.id ?? null;
      expenseId = createdExpense?.id ?? null;
    });
  } catch (error) {
    const response = responseForEditError(error);
    if (response) return response;
    throw error;
  }

  await saveDraftRunReport(db, payoutRunId);

  await recordAuditEvent({
    actor,
    action: "commission.payout_run.reimbursement.created",
    entityType: "payout_run_adjustment",
    entityId: adjustmentId,
    meta: {
      payoutRunId,
      expenseId,
      memberId: payload.memberId,
      amountCents: payload.amountCents,
      note: payload.note,
      vendor: payload.vendor ?? null,
      paidAt: payload.paidAt,
    },
  });

  return NextResponse.json({
    ok: true,
    payoutRunId,
    adjustmentId,
    expenseId,
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const { payoutRunId } = await context.params;
  if (!payoutRunId) {
    return NextResponse.json({ error: "missing_payout_run_id" }, { status: 400 });
  }

  const payload = DeleteReimbursementSchema.safeParse(
    (await request.json().catch(() => null)) as unknown,
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const adjustmentId = readString(payload.data.adjustmentId);
  if (!adjustmentId) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  let deletedExpenseId: string | null = null;
  let deletedAdjustmentId: string | null = null;
  let deletedMemberId: string | null = null;
  let deletedAmountCents: number | null = null;
  let deletedNote: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await ensureDraftPayoutRun(tx as ReturnType<typeof getDb>, payoutRunId);

      const [adjustment] = await tx
        .select({
          id: payoutRunAdjustments.id,
          kind: payoutRunAdjustments.kind,
          note: payoutRunAdjustments.note,
          amountCents: payoutRunAdjustments.amountCents,
          memberId: payoutRunAdjustments.memberId,
          expenseId: payoutRunAdjustments.expenseId,
        })
        .from(payoutRunAdjustments)
        .where(
          and(
            eq(payoutRunAdjustments.id, adjustmentId),
            eq(payoutRunAdjustments.payoutRunId, payoutRunId),
          ),
        )
        .limit(1);

      if (!adjustment?.id) {
        throw new Error("adjustment_not_found");
      }
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
        deletedExpenseId = adjustment.expenseId;
      }

      deletedAdjustmentId = readString(adjustment.id);
      deletedMemberId = readString(adjustment.memberId);
      deletedAmountCents = readFiniteNumber(adjustment.amountCents);
      deletedNote = readString(adjustment.note);
    });
  } catch (error) {
    const response = responseForEditError(error);
    if (response) return response;
    throw error;
  }

  await saveDraftRunReport(db, payoutRunId);

  await recordAuditEvent({
    actor,
    action: "commission.payout_run.reimbursement.deleted",
    entityType: "payout_run_adjustment",
    entityId: deletedAdjustmentId ?? adjustmentId,
    meta: {
      payoutRunId,
      expenseId: deletedExpenseId,
      memberId: deletedMemberId,
      amountCents: deletedAmountCents,
      note: deletedNote,
    },
  });

  return NextResponse.json({
    ok: true,
    payoutRunId,
    adjustmentId,
    expenseId: deletedExpenseId,
  });
}
