import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  adoptLegacySalesEscalationCallback,
  handleSalesEscalationConnectCallback,
  SalesEscalationCallbackError,
} from "@/lib/sales-escalation-call-operations";
import {
  buildTwilioWebhookUrl,
  verifyTwilioWebhookRequest,
} from "@/lib/twilio-webhook-auth";
import { getTwilioProviderSenderNumber } from "@/lib/twilio-provider";
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

function buildEscalationActionUrl(
  publicApiBaseUrl: string,
  eventKey: string,
  operationKey: string,
): string {
  const actionUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/escalate",
    publicApiBaseUrl,
  );
  actionUrl.searchParams.set("eventKey", eventKey);
  actionUrl.searchParams.set("operationKey", operationKey);
  return actionUrl.toString();
}

function buildGatherTwiML(input: {
  actionUrl: string;
  leadName: string | null;
}): string {
  const actionUrl = escapeTwilioXmlText(input.actionUrl);
  const leadName =
    typeof input.leadName === "string" && input.leadName.trim().length > 0
      ? escapeTwilioXmlText(input.leadName.trim())
      : null;
  const intro = leadName ? `New lead: ${leadName}.` : "New lead waiting.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${actionUrl}" method="POST">
    <Say>${intro} Press 1 to connect.</Say>
  </Gather>
  <Say>No input received. Goodbye.</Say>
</Response>`;
}

function buildConnectTwiML(input: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  dialActionUrl: string;
  noticeUrl: string;
}): string {
  const to = escapeTwilioXmlText(input.to);
  const callerId = escapeTwilioXmlText(input.callerId);
  const statusCallbackUrl = escapeTwilioXmlText(input.statusCallbackUrl);
  const dialActionUrl = escapeTwilioXmlText(input.dialActionUrl);
  const noticeUrl = escapeTwilioXmlText(input.noticeUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" action="${dialActionUrl}" method="POST" answerOnBridge="true" record="record-from-answer">
    <Number url="${noticeUrl}" statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  const publicApiBaseUrl = verified.publicBaseUrl;
  let eventKey = request.nextUrl.searchParams.get("eventKey")?.trim() ?? "";
  let operationKey =
    request.nextUrl.searchParams.get("operationKey")?.trim() ?? "";
  const digitsValue = verified.formData.get("Digits");
  const digits = typeof digitsValue === "string" ? digitsValue.trim() : null;
  const callSidValue = verified.formData.get("CallSid");
  const parentCallSid =
    typeof callSidValue === "string" ? callSidValue.trim() : null;
  let context: Awaited<ReturnType<typeof handleSalesEscalationConnectCallback>>;
  try {
    if (!eventKey && !operationKey) {
      const adopted = await adoptLegacySalesEscalationCallback({
        db: getDb(),
        parentCallSid,
      });
      eventKey = adopted.eventKey;
      operationKey = adopted.operationKey;
    }
    context = await handleSalesEscalationConnectCallback({
      db: getDb(),
      eventKey,
      operationKey,
      parentCallSid,
      customerDialRequested: digits === "1",
    });
  } catch (error) {
    console.warn("[twilio.escalate] callback_rejected", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>We could not safely connect this call.</Say><Hangup/></Response>`,
      error instanceof SalesEscalationCallbackError ? error.status : 500,
    );
  }

  if (!digits) {
    const actionUrl = buildEscalationActionUrl(
      publicApiBaseUrl,
      eventKey,
      context.operationKey,
    );
    return twimlResponse(
      buildGatherTwiML({ actionUrl, leadName: context.leadName }),
    );
  }

  if (digits !== "1") {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Not recognized. Goodbye.</Say>
</Response>`,
      200,
    );
  }
  const callerId = getTwilioProviderSenderNumber();
  if (!context.customerDialAllowed || !context.customerPhoneE164 || !callerId) {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>We could not safely connect this call.</Say><Hangup/></Response>`,
      200,
    );
  }

  const statusCallbackUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/call-status",
    publicApiBaseUrl,
  );
  statusCallbackUrl.searchParams.set("leg", "customer");
  statusCallbackUrl.searchParams.set("mode", "sales_escalation");
  statusCallbackUrl.searchParams.set("eventKey", eventKey);
  statusCallbackUrl.searchParams.set("operationKey", context.operationKey);
  const dialActionUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/dial-action",
    publicApiBaseUrl,
  );
  dialActionUrl.searchParams.set("leg", "customer");
  dialActionUrl.searchParams.set("mode", "sales_escalation");
  dialActionUrl.searchParams.set("eventKey", eventKey);
  dialActionUrl.searchParams.set("operationKey", context.operationKey);
  const noticeUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/notice",
    publicApiBaseUrl,
  );
  noticeUrl.searchParams.set("kind", "outbound");
  return twimlResponse(
    buildConnectTwiML({
      to: context.customerPhoneE164,
      callerId,
      statusCallbackUrl: statusCallbackUrl.toString(),
      dialActionUrl: dialActionUrl.toString(),
      noticeUrl: noticeUrl.toString(),
    }),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  let eventKey = request.nextUrl.searchParams.get("eventKey")?.trim() ?? "";
  let operationKey =
    request.nextUrl.searchParams.get("operationKey")?.trim() ?? "";
  const callSid = request.nextUrl.searchParams.get("CallSid")?.trim() ?? null;
  let context: Awaited<ReturnType<typeof handleSalesEscalationConnectCallback>>;
  try {
    if (!eventKey && !operationKey) {
      const adopted = await adoptLegacySalesEscalationCallback({
        db: getDb(),
        parentCallSid: callSid,
      });
      eventKey = adopted.eventKey;
      operationKey = adopted.operationKey;
    }
    context = await handleSalesEscalationConnectCallback({
      db: getDb(),
      eventKey,
      operationKey,
      parentCallSid: callSid,
      customerDialRequested: false,
    });
  } catch (error) {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>We could not connect the call. Please try again.</Say></Response>`,
      error instanceof SalesEscalationCallbackError ? error.status : 500,
    );
  }
  const actionUrl = buildEscalationActionUrl(
    verified.publicBaseUrl,
    eventKey,
    context.operationKey,
  );
  return twimlResponse(
    buildGatherTwiML({ actionUrl, leadName: context.leadName }),
  );
}
