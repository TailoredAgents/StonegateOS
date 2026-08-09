import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";
import { parseFinalTotalMutationResult } from "@/app/mobile/final-total-mutation";

type RouteContext = { params: Promise<{ appointmentId: string }> };

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { appointmentId } = await context.params;
  const upstream = await proxyMobileAppointmentRequest(
    request,
    `/api/appointments/${encodeRouteId(appointmentId)}/final-total`,
    {
      permission: "payments.collect",
      method: "PUT",
      forwardMutationHeaders: true,
    },
  );
  const payload = (await upstream
    .clone()
    .json()
    .catch(() => null)) as unknown;
  if (
    !parseFinalTotalMutationResult(
      payload,
      appointmentId.normalize("NFKC").trim(),
    )
  ) {
    return Response.json(
      {
        ok: false,
        code: "internal",
        message:
          "The payment service returned an invalid final-total receipt. The result was not accepted; retry with the same request key.",
        retryable: true,
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
          ...(upstream.headers.get("x-correlation-id")
            ? {
                "x-correlation-id": upstream.headers.get("x-correlation-id")!,
              }
            : {}),
        },
      },
    );
  }
  return upstream;
}
