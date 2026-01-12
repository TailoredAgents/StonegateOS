import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { expenses, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const CreateExpenseSchema = z.object({
  amountCents: z.number().int().nonnegative(),
  currency: z.string().trim().min(1).max(8).optional(),
  category: z.string().trim().max(120).optional().nullable(),
  vendor: z.string().trim().max(240).optional().nullable(),
  memo: z.string().trim().max(2000).optional().nullable(),
  method: z.string().trim().max(80).optional().nullable(),
  source: z.string().trim().max(80).optional(),
  paidAt: z.string().datetime().optional(),
  coverageStartAt: z.string().datetime().optional().nullable(),
  coverageEndAt: z.string().datetime().optional().nullable(),
  receiptFilename: z.string().trim().max(240).optional().nullable(),
  receiptUrl: z.string().trim().max(15_000_000).optional().nullable(),
  receiptContentType: z.string().trim().max(120).optional().nullable()
});

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOptionalDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseDataUrlToBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const base64Part = dataUrl.split(",")[1] ?? "";
  return Math.ceil((base64Part.length * 3) / 4);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "expenses.read");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const from = parseOptionalDate(url.searchParams.get("from"));
  const to = parseOptionalDate(url.searchParams.get("to"));

  const where = and(
    from ? gte(expenses.paidAt, from) : undefined,
    to ? lt(expenses.paidAt, to) : undefined
  );

  const db = getDb();
  const rows = await db
    .select({
      id: expenses.id,
      amountCents: expenses.amount,
      currency: expenses.currency,
      category: expenses.category,
      vendor: expenses.vendor,
      memo: expenses.memo,
      method: expenses.method,
      source: expenses.source,
      paidAt: expenses.paidAt,
      coverageStartAt: expenses.coverageStartAt,
      coverageEndAt: expenses.coverageEndAt,
      receiptFilename: expenses.receiptFilename,
      receiptContentType: expenses.receiptContentType,
      hasReceipt: expenses.receiptUrl
    })
    .from(expenses)
    .where(where)
    .orderBy(desc(expenses.paidAt))
    .limit(limit);

  return NextResponse.json({
    ok: true,
    expenses: rows.map((row) => ({
      id: row.id,
      amountCents: row.amountCents,
      currency: row.currency,
      category: row.category,
      vendor: row.vendor,
      memo: row.memo,
      method: row.method,
      source: row.source,
      paidAt: row.paidAt.toISOString(),
      coverageStartAt: row.coverageStartAt ? row.coverageStartAt.toISOString() : null,
      coverageEndAt: row.coverageEndAt ? row.coverageEndAt.toISOString() : null,
      receipt: row.hasReceipt
        ? {
            filename: row.receiptFilename ?? "receipt",
            contentType: row.receiptContentType ?? "application/octet-stream"
          }
        : null
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "expenses.write");
  if (permissionError) return permissionError;

  const contentType = request.headers.get("content-type") ?? "";
  let payload: z.infer<typeof CreateExpenseSchema> | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const amountCentsRaw = form.get("amountCents");
    const amountCents = typeof amountCentsRaw === "string" ? Number(amountCentsRaw) : NaN;
    if (!Number.isFinite(amountCents)) {
      return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    }

    const file = form.get("receiptFile");
    const filenameField = form.get("receiptFilename");
    const category = form.get("category");
    const vendor = form.get("vendor");
    const memo = form.get("memo");
    const method = form.get("method");
    const source = form.get("source");
    const paidAt = form.get("paidAt");
    const coverageStartAt = form.get("coverageStartAt");
    const coverageEndAt = form.get("coverageEndAt");

    let receiptUrl: string | null = null;
    let receiptFilename: string | null = null;
    let receiptContentType: string | null = null;

    if (file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        return NextResponse.json({ error: "file_too_large" }, { status: 413 });
      }
      receiptContentType = file.type || "application/octet-stream";
      const base64 = buf.toString("base64");
      receiptUrl = `data:${receiptContentType};base64,${base64}`;
      receiptFilename =
        typeof filenameField === "string" && filenameField.trim().length
          ? filenameField.trim()
          : file.name || "receipt";
    }

    payload = {
      amountCents: Math.round(amountCents),
      currency: "USD",
      category: typeof category === "string" && category.trim().length ? category.trim() : null,
      vendor: typeof vendor === "string" && vendor.trim().length ? vendor.trim() : null,
      memo: typeof memo === "string" && memo.trim().length ? memo.trim() : null,
      method: typeof method === "string" && method.trim().length ? method.trim() : null,
      source: typeof source === "string" && source.trim().length ? source.trim() : "manual",
      paidAt: typeof paidAt === "string" && paidAt.trim().length ? paidAt.trim() : undefined,
      coverageStartAt:
        typeof coverageStartAt === "string" && coverageStartAt.trim().length ? coverageStartAt.trim() : null,
      coverageEndAt:
        typeof coverageEndAt === "string" && coverageEndAt.trim().length ? coverageEndAt.trim() : null,
      receiptFilename,
      receiptUrl,
      receiptContentType
    };
  } else {
    const json = (await request.json().catch(() => null)) as unknown;
    const parsed = CreateExpenseSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", detail: parsed.error.flatten() }, { status: 400 });
    }
    payload = parsed.data;
  }

  const parsed = CreateExpenseSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", detail: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.receiptUrl) {
    const bytes = parseDataUrlToBytes(parsed.data.receiptUrl);
    if (bytes !== null && bytes > MAX_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
  }

  const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) {
    return NextResponse.json({ error: "invalid_paid_at" }, { status: 400 });
  }

  const coverageStartAt = parsed.data.coverageStartAt ? new Date(parsed.data.coverageStartAt) : null;
  const coverageEndAt = parsed.data.coverageEndAt ? new Date(parsed.data.coverageEndAt) : null;
  if (coverageStartAt && Number.isNaN(coverageStartAt.getTime())) {
    return NextResponse.json({ error: "invalid_coverage_start" }, { status: 400 });
  }
  if (coverageEndAt && Number.isNaN(coverageEndAt.getTime())) {
    return NextResponse.json({ error: "invalid_coverage_end" }, { status: 400 });
  }
  if (coverageStartAt && coverageEndAt && coverageEndAt.getTime() < coverageStartAt.getTime()) {
    return NextResponse.json({ error: "coverage_end_before_start" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [row] = await db
    .insert(expenses)
    .values({
      amount: parsed.data.amountCents,
      currency: parsed.data.currency ?? "USD",
      category: parsed.data.category ?? null,
      vendor: parsed.data.vendor ?? null,
      memo: parsed.data.memo ?? null,
      method: parsed.data.method ?? null,
      source: parsed.data.source ?? "manual",
      paidAt,
      coverageStartAt,
      coverageEndAt,
      receiptFilename: parsed.data.receiptFilename ?? null,
      receiptUrl: parsed.data.receiptUrl ?? null,
      receiptContentType: parsed.data.receiptContentType ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .returning({ id: expenses.id });

  if (!row?.id) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "expense.created",
    entityType: "expense",
    entityId: row.id,
    meta: {
      amountCents: parsed.data.amountCents,
      category: parsed.data.category ?? null,
      vendor: parsed.data.vendor ?? null
    }
  });

  return NextResponse.json({ ok: true, expenseId: row.id });
}

