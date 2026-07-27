import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";

const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;

type RouteContext = { params: Promise<{ mediaId: string }> };

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { mediaId } = await context.params;
  return proxyMobileAppointmentRequest(
    request,
    `/api/appointment-media/${encodeRouteId(mediaId)}/upload`,
    {
      permission: "appointment_media.capture",
      method: "PUT",
      bodyMode: "binary",
      maxBodyBytes: MAX_MEDIA_UPLOAD_BYTES,
    },
  );
}
