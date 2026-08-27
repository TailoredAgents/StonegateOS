import { proxyMobileExpenseRequest } from "@/app/api/mobile/expenses/lib/expense-proxy";

export async function POST(request: Request): Promise<Response> {
  const upstream = await proxyMobileExpenseRequest(
    request,
    "/api/admin/expenses/captures",
    { permission: "expenses.submit", method: "POST" },
  );
  if (!upstream.ok) return upstream;

  const payload = (await upstream
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const capture =
    payload?.["capture"] && typeof payload["capture"] === "object"
      ? (payload["capture"] as Record<string, unknown>)
      : null;
  const captureId = typeof capture?.["id"] === "string" ? capture["id"] : null;
  if (!captureId || typeof payload?.["uploadUrl"] !== "string") {
    return upstream;
  }

  return Response.json(
    {
      ...payload,
      uploadUrl: `/api/mobile/expenses/captures/${encodeURIComponent(captureId)}/upload`,
      uploadHeaders: {},
    },
    { status: upstream.status, headers: { "Cache-Control": "no-store" } },
  );
}
