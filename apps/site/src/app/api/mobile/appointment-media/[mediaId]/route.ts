import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";

type RouteContext = { params: Promise<{ mediaId: string }> };

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { mediaId } = await context.params;
  return proxyMobileAppointmentRequest(
    request,
    `/api/appointment-media/${encodeRouteId(mediaId)}`,
    { permission: "appointment_media.manage", method: "PATCH" },
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { mediaId } = await context.params;
  return proxyMobileAppointmentRequest(
    request,
    `/api/appointment-media/${encodeRouteId(mediaId)}`,
    { permission: "appointment_media.manage", method: "DELETE" },
  );
}
