import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/capabilities",
    { permission: ["expenses.submit", "expenses.approve"] },
  );
}
