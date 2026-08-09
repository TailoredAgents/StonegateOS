import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

const MAX_EXPORT_ROWS = 5_000;
const MAX_EXPORT_BYTES = 12 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: ["sales.read", "audit.export"],
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const query = request.nextUrl.searchParams.toString();
  try {
    const upstream = await callAdminApiAs(
      auth.principal,
      `/api/admin/sales/activity/export${query ? `?${query}` : ""}`,
      {
        method: "GET",
        headers: {
          Accept: "text/csv",
          "x-request-id": crypto.randomUUID(),
        },
      },
    );

    if (!upstream.ok) {
      const body = await readBoundedText(upstream, MAX_ERROR_BYTES);
      if (body === null) {
        return NextResponse.json(
          {
            error: "malformed_sales_activity_export_error",
            message:
              "The Sales Activity service returned an invalid error response. No file was released.",
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
      return new NextResponse(body || "sales_activity_export_failed", {
        status: upstream.status,
        headers: {
          "Content-Type":
            upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const disposition = upstream.headers.get("content-disposition") ?? "";
    const rowCount = upstream.headers.get("x-export-row-count") ?? "";
    const maximumRows = upstream.headers.get("x-export-maximum-rows") ?? "";
    const truncated = upstream.headers.get("x-export-truncated") ?? "";
    const auditCorrelationId =
      upstream.headers.get("x-audit-correlation-id") ?? "";
    if (
      !contentType.toLowerCase().startsWith("text/csv") ||
      !/^attachment; filename="stonegate-sales-activity-\d{4}-\d{2}-\d{2}\.csv"$/u.test(
        disposition,
      ) ||
      !/^\d+$/u.test(rowCount) ||
      !/^\d+$/u.test(maximumRows) ||
      Number(maximumRows) !== MAX_EXPORT_ROWS ||
      Number(rowCount) > MAX_EXPORT_ROWS ||
      truncated !== "false" ||
      !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditCorrelationId)
    ) {
      await upstream.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        {
          error: "malformed_sales_activity_export",
          message:
            "The Sales Activity service returned an invalid export receipt. No file was released.",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const body = await readBoundedText(upstream, MAX_EXPORT_BYTES);
    if (body === null) {
      return NextResponse.json(
        {
          error: "sales_activity_export_too_large",
          message:
            "The Sales Activity file exceeded its safe transfer limit. No file was released.",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
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
        error: "sales_activity_export_unavailable",
        message:
          "The Sales Activity service could not be reached. No file was downloaded.",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
