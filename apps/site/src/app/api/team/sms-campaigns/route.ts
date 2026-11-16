import { NextResponse, type NextRequest } from "next/server";
import { requireTeamPrincipal } from "../auth";
import { callAdminApiAs } from "@/app/team/lib/api";
async function proxy(request: NextRequest) {
  const write = request.method === "POST";
  const auth = await requireTeamPrincipal(request, {
    permissions: write
      ? ["marketing.write", "contacts.read", "messages.read"]
      : ["marketing.read", "contacts.read", "messages.read"],
    permissionMode: "all",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  const query = new URLSearchParams();
  for (const key of ["campaignId", "q"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const body = write ? await request.text() : undefined;
  if (body && body.length > 32_768)
    return NextResponse.json({ message: "Request too large" }, { status: 413 });
  try {
    const response = await callAdminApiAs(
      auth.principal,
      `/api/admin/sms-campaigns?${query}`,
      {
        method: request.method,
        body,
        headers: write
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
      {
        message:
          "Campaign service is unavailable. Your draft has not been sent.",
      },
      { status: 502 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
