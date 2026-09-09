import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { readStaffAppointmentResourceOptions } from "@/lib/staff-scheduling-resources";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ appointmentId: string }> },
) {
  const denied = await requirePermission(request, "appointments.read");
  if (denied) return denied;
  const { appointmentId } = await context.params;
  const headers = { "Cache-Control": "private, no-store" };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      appointmentId,
    )
  )
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers },
    );
  const result = await readStaffAppointmentResourceOptions(appointmentId);
  return NextResponse.json(
    result ? { ok: true, ...result } : { ok: false, error: "not_found" },
    { status: result ? 200 : 404, headers },
  );
}
