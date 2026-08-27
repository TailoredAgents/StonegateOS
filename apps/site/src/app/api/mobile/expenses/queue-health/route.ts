import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export async function POST(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/queue-health",
    {
      permission: "expenses.submit",
      method: "POST",
    },
  );
}
