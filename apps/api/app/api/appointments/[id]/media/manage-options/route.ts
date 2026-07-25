import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAppointmentMediaManageOptions } from "@/lib/appointment-media";
import { appointmentMediaErrorResponse } from "@/lib/appointment-media-route";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "appointment_media.manage",
  );
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  try {
    const options = await getAppointmentMediaManageOptions(appointmentId);
    return NextResponse.json(
      { ok: true, ...options },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return appointmentMediaErrorResponse(error);
  }
}
