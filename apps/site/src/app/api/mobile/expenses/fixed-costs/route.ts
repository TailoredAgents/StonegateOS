import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const values = new URL(request.url).searchParams.getAll("asOf");
  const value = values.length === 1 ? (values[0]?.trim() ?? "") : "";
  if (
    values.length > 1 ||
    (values.length === 1 && !/^\d{4}-\d{2}-\d{2}$/u.test(value))
  ) {
    return Response.json(
      {
        ok: false,
        error: "invalid_as_of_date",
        message: "Choose one as-of date in YYYY-MM-DD format.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const upstream = values.length
    ? `/api/admin/expenses/fixed-costs?asOf=${encodeURIComponent(value)}`
    : "/api/admin/expenses/fixed-costs";
  return proxyMobileExpenseRequest(request, upstream, {
    permission: "expenses.approve",
  });
}

export async function POST(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(request, "/api/admin/expenses/fixed-costs", {
    permission: "expenses.approve",
    method: "POST",
  });
}
