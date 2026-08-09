import {
  encodeRouteId,
  proxyMobileAppointmentRequest,
} from "@/app/api/mobile/lib/appointment-proxy";
import { parseManualPaymentMutationResult } from "@/app/mobile/payment-collection-mutation";

type RouteContext = { params: Promise<{ appointmentId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { appointmentId } = await context.params;
  const normalizedAppointmentId = appointmentId
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  const upstream = await proxyMobileAppointmentRequest(
    request,
    `/api/appointments/${encodeRouteId(appointmentId)}/manual-payments`,
    {
      permission: "payments.collect",
      method: "POST",
      forwardMutationHeaders: true,
      rejectQueryParameters: true,
      maxBodyBytes: 2 * 1024,
    },
  );
  if (!upstream.ok) return upstream;
  const payload = (await upstream
    .clone()
    .json()
    .catch(() => null)) as unknown;
  const result = parseManualPaymentMutationResult(
    payload,
    normalizedAppointmentId,
  );
  if (!result?.ok) {
    return Response.json(
      {
        ok: false,
        code: "internal",
        message:
          "The payment service returned an invalid manual-payment receipt. Nothing was accepted; retry with the same request key.",
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
