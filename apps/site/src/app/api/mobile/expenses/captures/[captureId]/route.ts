import {
  encodeExpenseRouteId,
  proxyMobileExpenseRequest,
} from "@/app/api/mobile/expenses/lib/expense-proxy";

type RouteContext = { params: Promise<{ captureId: string }> };
const PERMISSIONS = ["expenses.submit", "expenses.approve"] as const;

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { captureId } = await context.params;
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/captures/${encodeExpenseRouteId(captureId)}`,
    { permission: PERMISSIONS },
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { captureId } = await context.params;
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/captures/${encodeExpenseRouteId(captureId)}`,
    { permission: PERMISSIONS, method: "DELETE" },
  );
}
