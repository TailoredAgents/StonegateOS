import {
  encodeExpenseRouteId,
  proxyMobileExpenseRequest,
} from "@/app/api/mobile/expenses/lib/expense-proxy";

type RouteContext = { params: Promise<{ seriesId: string }> };

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { seriesId } = await context.params;
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/fixed-costs/${encodeExpenseRouteId(seriesId)}`,
    { permission: "expenses.approve", method: "PATCH" },
  );
}
