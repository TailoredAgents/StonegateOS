import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, partnerInvoices, partnerBillingDocumentOperations, partnerBillingRefundRequests } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { encodePortalV2Cursor, parsePortalV2Pagination } from "@/lib/portal-v2-contract/pagination";

const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
const Identity = z.object({ accountId: z.string().uuid(), invoiceId: z.string().uuid() });
const Kind = z.enum(["documents", "refunds"]);
const Cursor = Identity.extend({ kind: Kind, id: z.string().uuid(), createdAt: z.string().datetime() }).strict();
type Context = { params: Promise<{ accountId: string; invoiceId: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const denied = await requirePermission(request, "partners.commercial.read");
  if (denied) return denied;
  const identity = Identity.safeParse(await context.params);
  const kind = Kind.safeParse(request.nextUrl.searchParams.get("kind"));
  if (!identity.success || !kind.success || request.nextUrl.searchParams.getAll("kind").length !== 1)
    return NextResponse.json({ ok: false, error: "invalid_filter" }, { status: 400, headers });
  const { accountId, invoiceId } = identity.data;
  const page = parsePortalV2Pagination(request.nextUrl.searchParams, {
    cursorKind: "staff_invoice_history",
    defaultLimit: 50,
    maximumLimit: 100,
    allowedQueryKeys: new Set(["kind"]),
    validateCursorPayload: (value): value is z.infer<typeof Cursor> => {
      const parsed = Cursor.safeParse(value);
      return parsed.success && parsed.data.accountId === accountId && parsed.data.invoiceId === invoiceId && parsed.data.kind === kind.data;
    },
  });
  if (!page.ok) return NextResponse.json({ ok: false, error: "invalid_pagination" }, { status: 400, headers });
  try {
    const result = await getDb().transaction(async (tx) => {
      const [invoice] = await tx.select({ id: partnerInvoices.id }).from(partnerInvoices)
        .where(and(eq(partnerInvoices.partnerAccountId, accountId), eq(partnerInvoices.id, invoiceId))).limit(1);
      if (!invoice) return null;
      const table = kind.data === "documents" ? partnerBillingDocumentOperations : partnerBillingRefundRequests;
      const after = page.cursor?.payload;
      // Preserve PostgreSQL microseconds in the transport cursor. JavaScript
      // Date truncation would skip rows sharing a millisecond at a page edge.
      const createdAt = sql<string>`to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const filter = and(eq(table.partnerAccountId, accountId), eq(table.partnerInvoiceId, invoiceId),
        after ? sql`(${table.createdAt}, ${table.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : undefined);
      const rows = kind.data === "documents"
        ? await tx.select({ id: partnerBillingDocumentOperations.id, createdAt, kind: partnerBillingDocumentOperations.documentType,
            status: partnerBillingDocumentOperations.status, documentId: partnerBillingDocumentOperations.documentId })
            .from(partnerBillingDocumentOperations).where(filter).orderBy(desc(table.createdAt), desc(table.id)).limit(page.limit + 1)
        : await tx.select({ id: partnerBillingRefundRequests.id, createdAt, paymentId: partnerBillingRefundRequests.paymentId,
            amountCents: partnerBillingRefundRequests.amountCents, status: partnerBillingRefundRequests.status })
            .from(partnerBillingRefundRequests).where(filter).orderBy(desc(table.createdAt), desc(table.id)).limit(page.limit + 1);
      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      return { accountId, invoiceId, kind: kind.data, items,
        nextCursor: rows.length > page.limit && last ? encodePortalV2Cursor({ kind: "staff_invoice_history", limit: page.limit,
          payload: { accountId, invoiceId, kind: kind.data, id: last.id, createdAt: last.createdAt } }) : null };
    }, { isolationLevel: "repeatable read" });
    return NextResponse.json(result ? { ok: true, ...result } : { ok: false, error: "not_found" }, { status: result ? 200 : 404, headers });
  } catch {
    return NextResponse.json({ ok: false, error: "history_unavailable" }, { status: 503, headers });
  }
}
