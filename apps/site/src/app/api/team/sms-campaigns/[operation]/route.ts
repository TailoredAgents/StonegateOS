import { NextResponse, type NextRequest } from "next/server";
import { requireTeamPrincipal } from "../../auth";
import { callAdminApiAs } from "@/app/team/lib/api";
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ operation: string }> },
) {
  const { operation } = await context.params;
  if (!["drafts", "qualification"].includes(operation))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await requireTeamPrincipal(request, {
    permissions: [
      request.method === "POST" ? "marketing.write" : "marketing.read",
      "contacts.read",
    ],
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  if (auth.principal.roleSlug !== "owner")
    return NextResponse.json(
      { error: "Owner access required" },
      { status: 403 },
    );
  const body = request.method === "POST" ? await request.text() : undefined;
  if (body && new TextEncoder().encode(body).length > 1024 * 1024)
    return NextResponse.json(
      { error: "Import must be less than 1 MB" },
      { status: 413 },
    );
  const query = new URLSearchParams();
  for (const key of ["campaignId", "contactId", "limit", "offset"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) query.set(key, value);
  }
  try {
    const response = await callAdminApiAs(
      auth.principal,
      `/api/admin/sms-campaigns/${operation}?${query}`,
      {
        method: request.method,
        body,
        headers: body
          ? { "Idempotency-Key": request.headers.get("Idempotency-Key") ?? "" }
          : undefined,
      },
    );
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Campaign service unavailable. Retry the same request safely." },
      { status: 502 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
