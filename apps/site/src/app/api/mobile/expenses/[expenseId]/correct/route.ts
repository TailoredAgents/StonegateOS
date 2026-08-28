import {
  encodeExpenseRouteId,
  proxyMobileExpenseRequest,
} from "@/app/api/mobile/expenses/lib/expense-proxy";

type RouteContext = { params: Promise<{ expenseId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { expenseId } = await context.params;
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/${encodeExpenseRouteId(expenseId)}/correct`,
    { permission: "expenses.approve", method: "POST" },
  );
}
