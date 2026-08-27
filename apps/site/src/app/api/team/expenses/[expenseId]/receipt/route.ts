import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  parseVerifiedLegacyExpenseReceipt,
  safeExpenseReceiptResponseHeaders,
} from "@/lib/legacy-expense-receipt";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "expenses.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const { expenseId } = await context.params;
  if (!expenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/admin/expenses/${encodeURIComponent(expenseId)}/receipt`,
    { redirect: "manual" },
  );
  if (apiResponse.status >= 300 && apiResponse.status < 400) {
    const location = apiResponse.headers.get("location") ?? "";
    let target: URL | null = null;
    try {
      target = new URL(location);
    } catch {
      target = null;
    }
    if (
      !target ||
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password
    ) {
      return NextResponse.json(
        { error: "invalid_receipt_location" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    return new Response(null, {
      status: 307,
      headers: {
        Location: target.toString(),
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (!apiResponse.ok) {
    return NextResponse.json(
      { error: "not_found" },
      { status: apiResponse.status },
    );
  }

  const payload = (await apiResponse.json()) as {
    ok?: boolean;
    filename?: string;
    contentType?: string;
    dataUrl?: string;
  };

  if (!payload?.dataUrl) {
    return NextResponse.json({ error: "no_receipt" }, { status: 404 });
  }

  const parsed = parseVerifiedLegacyExpenseReceipt({
    dataUrl: payload.dataUrl,
    reportedContentType: payload.contentType,
  });
  if (!parsed) {
    return NextResponse.json(
      { error: "invalid_receipt" },
      { status: 415, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const contentType = parsed.contentType;
  const arrayBuffer = new ArrayBuffer(parsed.buffer.byteLength);
  new Uint8Array(arrayBuffer).set(parsed.buffer);
  const blob = new Blob([arrayBuffer], { type: contentType });
  return new Response(blob, {
    headers: safeExpenseReceiptResponseHeaders({
      filename: payload.filename ?? "receipt",
      contentType,
    }),
  });
}
