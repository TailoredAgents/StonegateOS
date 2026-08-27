import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

const FILTERS = new Set([
  "all",
  "pending",
  "approved",
  "rejected",
  "reimbursement",
]);

export async function GET(request: Request): Promise<Response> {
  const filter = new URL(request.url).searchParams.get("filter") ?? "all";
  if (!FILTERS.has(filter)) {
    return Response.json(
      { ok: false, error: "invalid_filter", message: "Choose a valid filter." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/submissions?filter=${encodeURIComponent(filter)}`,
    { permission: ["expenses.submit", "expenses.approve"] },
  );
}

export async function POST(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(request, "/api/admin/expenses/submissions", {
    permission: "expenses.submit",
    method: "POST",
  });
}
