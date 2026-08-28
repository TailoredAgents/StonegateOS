import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

const FILTERS = new Set([
  "all",
  "pending",
  "approved",
  "rejected",
  "reimbursement",
  "dump_tickets",
]);

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const filter = searchParams.get("filter") ?? "all";
  if (!FILTERS.has(filter)) {
    return Response.json(
      { ok: false, error: "invalid_filter", message: "Choose a valid filter." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const limit = searchParams.get("limit") ?? "40";
  if (!/^\d{1,3}$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
    return Response.json(
      {
        ok: false,
        error: "invalid_limit",
        message: "Choose a valid page size.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const cursor = searchParams.get("cursor")?.trim() ?? "";
  if (cursor.length > 512) {
    return Response.json(
      {
        ok: false,
        error: "invalid_cursor",
        message: "Refresh expense history.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const upstream = new URLSearchParams({ filter, limit });
  if (cursor) upstream.set("cursor", cursor);
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/submissions?${upstream.toString()}`,
    { permission: ["expenses.submit", "expenses.approve"] },
  );
}

export async function POST(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(request, "/api/admin/expenses/submissions", {
    permission: "expenses.submit",
    method: "POST",
  });
}
