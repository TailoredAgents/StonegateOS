import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "expenses.export",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const query = request.nextUrl.searchParams.toString();
  try {
    const upstream = await callAdminApiAs(
      auth.principal,
      `/api/admin/expenses/export${query ? `?${query}` : ""}`,
      {
        method: "GET",
        headers: {
          Accept: "text/csv",
          "x-request-id": crypto.randomUUID(),
        },
      },
    );

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      return new NextResponse(body || "expense_export_failed", {
        status: upstream.status,
        headers: {
          "Content-Type":
            upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const rowCount = upstream.headers.get("x-export-row-count") ?? "";
    const maximumRows = upstream.headers.get("x-export-maximum-rows") ?? "";
    const truncated = upstream.headers.get("x-export-truncated") ?? "";
    const auditCorrelationId =
      upstream.headers.get("x-audit-correlation-id") ?? "";
    if (
      !contentType.toLowerCase().startsWith("text/csv") ||
      !/^\d+$/u.test(rowCount) ||
      !/^\d+$/u.test(maximumRows) ||
      Number(rowCount) > Number(maximumRows) ||
      truncated !== "false" ||
      !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditCorrelationId)
    ) {
      await upstream.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        {
          error: "malformed_expense_export",
          message:
            "The expense service returned an invalid export receipt. No file was released.",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition":
          upstream.headers.get("content-disposition") ??
          'attachment; filename="stonegate-expenses.csv"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Export-Row-Count": rowCount,
        "X-Export-Maximum-Rows": maximumRows,
        "X-Export-Truncated": truncated,
        "X-Audit-Correlation-Id": auditCorrelationId,
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "expense_export_unavailable",
        message:
          "The expense service could not be reached. No file was downloaded.",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
