import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";

type RouteContext = { params: Promise<{ mediaId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { mediaId } = await context.params;
  return proxyMobileAppointmentRequest(
    request,
    `/api/appointment-media/${encodeRouteId(mediaId)}/complete`,
    { permission: "appointment_media.capture", method: "POST" },
  );
}
