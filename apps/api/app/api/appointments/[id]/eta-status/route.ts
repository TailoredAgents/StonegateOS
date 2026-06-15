import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest } from "@/lib/audit";
import { updateCrewEtaStatus } from "@/lib/eta-agent";
import { isAdminRequest } from "../../../web/admin";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  const payload = (await request.json().catch(() => null)) as {
    status?: string;
    source?: string;
    note?: string | null;
  } | null;
  const status = typeof payload?.status === "string" ? payload.status.trim() : "";
  if (!id || !status) {
    return NextResponse.json({ error: "status_required" }, { status: 400 });
  }

  const result = await updateCrewEtaStatus({
    appointmentId: id,
    status,
    source:
      payload?.source === "mobile" || payload?.source === "sms" || payload?.source === "system"
        ? payload.source
        : "crm",
    note: typeof payload?.note === "string" ? payload.note : null,
    actor: getAuditActorFromRequest(request),
  });

  if (!result.ok) {
    const httpStatus = result.error === "appointment_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status: httpStatus });
  }

  return NextResponse.json({ ok: true, status: result.status, draftId: result.draftId });
}
