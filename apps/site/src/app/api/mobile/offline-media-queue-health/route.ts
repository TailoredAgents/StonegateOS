import { proxyMobileAppointmentRequest } from "@/app/api/mobile/lib/appointment-proxy";

export async function POST(request: Request): Promise<Response> {
  return proxyMobileAppointmentRequest(
    request,
    "/api/mobile/offline-media-queue-health",
    {
      permission: "appointments.read",
      method: "POST",
    },
  );
}
