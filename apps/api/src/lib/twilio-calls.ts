import { createTwilioProviderCall } from "@/lib/twilio-provider";

export type TwilioOutboundCallResult =
  | {
      ok: true;
      callSid: string;
      provider: "twilio";
      deliveryCertainty: "accepted";
      providerIdempotencySupported: false;
      retryable: false;
    }
  | {
      ok: false;
      callSid: null;
      provider: "twilio";
      deliveryCertainty: "not_sent" | "uncertain";
      providerIdempotencySupported: false;
      retryable: boolean;
      detail:
        | "twilio_call_not_configured"
        | "twilio_call_invalid_configuration"
        | "twilio_call_external_sends_disabled"
        | "twilio_call_invalid_input"
        | "twilio_call_timeout"
        | "twilio_call_transport_error"
        | "twilio_call_response_invalid"
        | "twilio_call_response_too_large"
        | "twilio_call_provider_failed"
        | `twilio_call_failed:${number}`;
      status: number | null;
    };

export async function createTwilioOutboundCall(input: {
  to: string;
  requestUrl: string;
  statusCallbackUrl: string;
}): Promise<TwilioOutboundCallResult> {
  const result = await createTwilioProviderCall(input);
  if (result.ok) {
    return {
      ok: true,
      callSid: result.callSid,
      provider: "twilio",
      deliveryCertainty: "accepted",
      providerIdempotencySupported: false,
      retryable: false,
    };
  }

  const detail = (() => {
    if (result.code === "not_configured")
      return "twilio_call_not_configured" as const;
    if (result.code === "invalid_configuration")
      return "twilio_call_invalid_configuration" as const;
    if (result.code === "operation_disabled")
      return "twilio_call_external_sends_disabled" as const;
    if (result.code === "invalid_input")
      return "twilio_call_invalid_input" as const;
    if (result.code === "timeout") return "twilio_call_timeout" as const;
    if (result.code === "transport_error")
      return "twilio_call_transport_error" as const;
    if (result.code === "response_too_large")
      return "twilio_call_response_too_large" as const;
    if (result.code === "malformed_response")
      return "twilio_call_response_invalid" as const;
    return result.status === null
      ? ("twilio_call_provider_failed" as const)
      : (`twilio_call_failed:${result.status}` as const);
  })();
  return {
    ok: false,
    callSid: null,
    provider: "twilio",
    deliveryCertainty:
      result.certainty === "uncertain" ? "uncertain" : "not_sent",
    providerIdempotencySupported: false,
    retryable: result.retryable,
    detail,
    status: result.status,
  };
}
