import {
  encodeExpenseRouteId,
  proxyMobileExpenseRequest,
} from "@/app/api/mobile/expenses/lib/expense-proxy";

type RouteContext = { params: Promise<{ captureId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { captureId } = await context.params;
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/captures/${encodeExpenseRouteId(captureId)}/finalize`,
    {
      permission: ["expenses.submit", "expenses.approve"],
      method: "POST",
    },
  );
}
