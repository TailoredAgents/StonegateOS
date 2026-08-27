import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export async function GET(request: Request): Promise<Response> {
  return proxyMobileExpenseRequest(request, "/api/admin/expenses/categories", {
    permission: ["expenses.submit", "expenses.approve"],
  });
}
