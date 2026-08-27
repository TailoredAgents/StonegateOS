import {
  encodeExpenseRouteId,
  proxyMobileExpenseRequest,
} from "@/app/api/mobile/expenses/lib/expense-proxy";

type RouteContext = { params: Promise<{ captureId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { captureId } = await context.params;
  const variant = new URL(request.url).searchParams.get("variant");
  if (variant !== null && variant !== "original" && variant !== "normalized") {
    return Response.json(
      { ok: false, error: "invalid_variant" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const query = variant ? `?variant=${variant}` : "";
  return proxyMobileExpenseRequest(
    request,
    `/api/admin/expenses/captures/${encodeExpenseRouteId(captureId)}/content${query}`,
    { permission: ["expenses.submit", "expenses.approve"] },
  );
}
