import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  handleManualCallDialActionCallback,
  ManualCallCallbackError,
} from "@/lib/manual-call-callbacks";
import {
  adoptLegacySalesEscalationCallback,
  handleSalesEscalationDialActionCallback,
  SalesEscalationCallbackError,
} from "@/lib/sales-escalation-call-operations";
import { verifyTwilioWebhookRequest } from "@/lib/twilio-webhook-auth";
import { escapeTwilioXmlText } from "@/lib/twilio-xml";

export const dynamic = "force-dynamic";

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: FormDataEntryValue | null): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(value: FormDataEntryValue | null): boolean | null {
  const raw = readString(value)?.toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  const { formData } = verified;

  const leg = request.nextUrl.searchParams.get("leg")?.trim() || "unknown";
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || null;
  let eventKey = request.nextUrl.searchParams.get("eventKey")?.trim() || "";
  let operationKey =
    request.nextUrl.searchParams.get("operationKey")?.trim() || "";
  const requestKey =
    request.nextUrl.searchParams.get("requestKey")?.trim() || null;

  const payload = {
    leg,
    callSid: readString(formData.get("CallSid")),
    parentCallSid: readString(formData.get("ParentCallSid")),
    callStatus: readString(formData.get("CallStatus")),
    from: readString(formData.get("From")),
    to: readString(formData.get("To")),
    dialCallSid: readString(formData.get("DialCallSid")),
    dialCallStatus: readString(formData.get("DialCallStatus")),
    dialCallDuration: readNumber(formData.get("DialCallDuration")),
    dialBridged: readString(formData.get("DialBridged")),
    dialSipResponseCode: readString(formData.get("DialSipResponseCode")),
    dialHangupCause: readString(formData.get("DialHangupCause")),
    dialCallQuality: readString(formData.get("DialCallQuality")),
  };

  console.info("[twilio.dial_action]", {
    leg: payload.leg,
    hasCallSid: Boolean(payload.callSid),
    hasParentCallSid: Boolean(payload.parentCallSid),
    callStatus: payload.callStatus,
    hasDialCallSid: Boolean(payload.dialCallSid),
    dialCallStatus: payload.dialCallStatus,
    dialCallDuration: payload.dialCallDuration,
    dialBridged: payload.dialBridged,
    dialSipResponseCode: payload.dialSipResponseCode,
    dialHangupCause: payload.dialHangupCause,
    dialCallQuality: payload.dialCallQuality,
    hasFrom: Boolean(payload.from),
    hasTo: Boolean(payload.to),
  });

  if (requestKey) {
    if (leg !== "customer") {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        400,
      );
    }
    try {
      await handleManualCallDialActionCallback({
        db: getDb(),
        requestKey,
        parentCallSid: payload.callSid ?? payload.parentCallSid,
        customerCallSid: payload.dialCallSid,
        dialCallStatus: payload.dialCallStatus,
        dialCallDuration: payload.dialCallDuration,
        dialBridged: readBoolean(formData.get("DialBridged")),
      });
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        200,
      );
    } catch (error) {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        error instanceof ManualCallCallbackError ? error.status : 500,
      );
    }
  }

  if (mode === "sales_escalation") {
    if (leg !== "customer") {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        400,
      );
    }
    if (!eventKey && !operationKey) {
      try {
        const adopted = await adoptLegacySalesEscalationCallback({
          db: getDb(),
          parentCallSid: payload.callSid ?? payload.parentCallSid,
        });
        eventKey = adopted.eventKey;
        operationKey = adopted.operationKey;
      } catch (error) {
        return twimlResponse(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
          error instanceof SalesEscalationCallbackError ? error.status : 500,
        );
      }
    }
    try {
      const result = await handleSalesEscalationDialActionCallback({
        db: getDb(),
        eventKey,
        operationKey,
        parentCallSid: payload.callSid ?? payload.parentCallSid,
        customerCallSid: payload.dialCallSid,
        status: payload.dialCallStatus ?? payload.callStatus,
        durationSec: payload.dialCallDuration,
        bridged: readBoolean(formData.get("DialBridged")),
      });
      const agentMessage =
        result.outcome === "connected"
          ? null
          : result.outcome === "not_connected"
            ? "The customer did not connect. Please try again later."
            : "The call result needs review before another attempt.";
      return agentMessage
        ? twimlResponse(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeTwilioXmlText(agentMessage)}</Say><Hangup/></Response>`,
            200,
          )
        : twimlResponse(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
            200,
          );
    } catch (error) {
      console.warn("[twilio.dial_action] sales_escalation_callback_failed", {
        hasEventKey: true,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        error instanceof SalesEscalationCallbackError ? error.status : 500,
      );
    }
  }

  return twimlResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    200,
  );
}
