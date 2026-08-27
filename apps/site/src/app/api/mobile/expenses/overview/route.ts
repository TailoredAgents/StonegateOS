import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export async function GET(request: Request): Promise<Response> {
  const values = new URL(request.url).searchParams.getAll("weekStart");
  const weekStart = values.length === 1 ? (values[0]?.trim() ?? "") : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(weekStart)) {
    return Response.json(
      {
        ok: false,
        error: "invalid_week_start",
        message: "Choose one week in YYYY-MM-DD format.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/overview?weekStart=${encodeURIComponent(weekStart)}`,
    { permission: "financials.read" },
  );
}
