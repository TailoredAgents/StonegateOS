import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";

type RouteContext = { params: Promise<{ appointmentId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { appointmentId } = await context.params;
  return proxyMobileAppointmentRequest(
    request,
    `/api/appointments/${encodeRouteId(appointmentId)}/media/manage-options`,
    { permission: "appointment_media.manage" },
  );
}
