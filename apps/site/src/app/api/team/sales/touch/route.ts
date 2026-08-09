import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "../../auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "sales.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const payload = (await request.json().catch(() => null)) as {
    contactId?: string;
  } | null;
  const contactId =
    typeof payload?.contactId === "string" ? payload.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json(
      { ok: false, message: "Missing contact id." },
      { status: 400 },
    );
  }

  const response = await callAdminApiAs(
    auth.principal,
    "/api/admin/sales/touch",
    {
      method: "POST",
      body: JSON.stringify({ contactId }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json(
      { ok: false, message: text || "Unable to mark contacted." },
      { status: response.status },
    );
  }

  return NextResponse.json({ ok: true });
}
