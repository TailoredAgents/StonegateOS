import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiForCurrentSession } from "@/app/team/lib/api";
import {
  hasMobilePermission,
  resolveMobileSessionFromCookies,
} from "../../../../../mobile/lib/session";
import {
  parseVerifiedLegacyExpenseReceipt,
  safeExpenseReceiptResponseHeaders,
} from "@/lib/legacy-expense-receipt";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (
    !hasMobilePermission(session.teamMember.permissions, "expenses.submit") &&
    !hasMobilePermission(session.teamMember.permissions, "expenses.approve")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { expenseId } = await context.params;
  const normalizedExpenseId = expenseId.trim();
  if (!normalizedExpenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const apiResponse = await callAdminApiForCurrentSession(
    `/api/admin/expenses/${encodeURIComponent(normalizedExpenseId)}/receipt`,
    {
      method: "GET",
      redirect: "manual",
    },
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

  const payload = (await apiResponse.json().catch(() => null)) as {
    ok?: boolean;
    filename?: string;
    contentType?: string;
    dataUrl?: string;
  } | null;

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
