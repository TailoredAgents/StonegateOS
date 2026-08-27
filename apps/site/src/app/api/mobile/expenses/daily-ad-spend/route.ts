import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

function businessDate(request: Request): string | null {
  const values = new URL(request.url).searchParams.getAll("businessDate");
  const value = values.length === 1 ? (values[0]?.trim() ?? "") : "";
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

export async function GET(request: Request): Promise<Response> {
  const date = businessDate(request);
  if (!date) {
    return Response.json(
      {
        ok: false,
        error: "invalid_business_date",
        message: "Choose one date in YYYY-MM-DD format.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/daily-ad-spend?businessDate=${encodeURIComponent(date)}`,
    { permission: "ad_spend.write" },
  );
}

export async function POST(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/daily-ad-spend",
    { permission: "ad_spend.write", method: "POST" },
  );
}

export async function PUT(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/daily-ad-spend",
    { permission: "ad_spend.write", method: "PUT" },
  );
}
