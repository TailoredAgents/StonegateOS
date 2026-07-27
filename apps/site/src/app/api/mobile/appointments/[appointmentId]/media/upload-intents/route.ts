import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";

type RouteContext = { params: Promise<{ appointmentId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { appointmentId } = await context.params;
  const response = await proxyMobileAppointmentRequest(
    request,
    `/api/appointments/${encodeRouteId(appointmentId)}/media/upload-intents`,
    { permission: "appointment_media.capture", method: "POST" },
  );
  if (!response.ok) return response;

  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") return response;

  const root = payload as Record<string, unknown>;
  let rewroteUploadUrl = false;
  const rewriteIntent = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const intent = value as Record<string, unknown>;
    if (
      intent["alreadyCompleted"] === true ||
      intent["status"] === "ready" ||
      intent["status"] === "processing"
    ) {
      return value;
    }
    const mediaId =
      typeof intent["mediaId"] === "string"
        ? intent["mediaId"]
        : typeof intent["id"] === "string"
          ? intent["id"]
          : null;
    if (!mediaId || typeof intent["uploadUrl"] !== "string") return value;
    rewroteUploadUrl = true;
    return {
      ...intent,
      uploadUrl: `/api/mobile/appointment-media/${encodeRouteId(mediaId)}/upload`,
      uploadHeaders: {},
    };
  };

  if (Array.isArray(root["intents"])) {
    root["intents"] = root["intents"].map(rewriteIntent);
  }
  if (Array.isArray(root["uploads"])) {
    root["uploads"] = root["uploads"].map(rewriteIntent);
  }
  if (root["intent"]) {
    root["intent"] = rewriteIntent(root["intent"]);
  }

  if (!rewroteUploadUrl) return response;

  return Response.json(root, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}
