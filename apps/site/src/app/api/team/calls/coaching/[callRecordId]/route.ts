import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { requireTeamRole } from "../../../auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ callRecordId: string }> };

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const auth = await requireTeamRole(request, { roles: ["owner"], returnJson: true });
  if (!auth.ok) return auth.response;

  const { callRecordId } = await params;
  const id = typeof callRecordId === "string" ? callRecordId.trim() : "";
  if (!id) {
    return NextResponse.json({ ok: false, message: "Missing call id." }, { status: 400 });
  }

  const response = await callAdminApi(`/api/admin/calls/coaching/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return NextResponse.json({ ok: false, message: text || "Unable to delete call coaching." }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}
