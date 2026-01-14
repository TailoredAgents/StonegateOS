import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { normalizePhone } from "../../../web/utils";

export const dynamic = "force-dynamic";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveDialTarget(request: NextRequest): string | null {
  const to = request.nextUrl.searchParams.get("to");
  if (!to) return null;
  try {
    return normalizePhone(to).e164;
  } catch {
    return null;
  }
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    }
  });
}

function buildGatherTwiML(input: { actionUrl: string; leadName: string | null }): string {
  const actionUrl = escapeXml(input.actionUrl);
  const leadName = typeof input.leadName === "string" && input.leadName.trim().length > 0 ? escapeXml(input.leadName.trim()) : null;
  const intro = leadName ? `New lead: ${leadName}.` : "New lead waiting.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${actionUrl}" method="POST">
    <Say>${intro} Press 1 to connect.</Say>
  </Gather>
  <Say>No input received. Goodbye.</Say>
</Response>`;
}

function buildConnectTwiML(input: { to: string; callerId: string; statusCallbackUrl: string; dialActionUrl: string }): string {
  const to = escapeXml(input.to);
  const callerId = escapeXml(input.callerId);
  const statusCallbackUrl = escapeXml(input.statusCallbackUrl);
  const dialActionUrl = escapeXml(input.dialActionUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" action="${dialActionUrl}" method="POST" answerOnBridge="true">
    <Number statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;
}

async function readDigits(request: NextRequest): Promise<string | null> {
  try {
    const formData = await request.formData();
    const digits = formData.get("Digits");
    return typeof digits === "string" ? digits.trim() : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const to = resolveDialTarget(request);
  const callerId = process.env["TWILIO_FROM"] ?? null;
  if (!to || !callerId) {
    console.warn("[twilio.escalate] missing_to_or_from", {
      hasTo: Boolean(to),
      hasCallerId: Boolean(callerId),
      url: request.nextUrl.toString()
    });
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We could not connect the call. Please try again.</Say>
</Response>`,
      200
    );
  }

  const digits = await readDigits(request);
  if (!digits) {
    const leadName = request.nextUrl.searchParams.get("name");
    return twimlResponse(buildGatherTwiML({ actionUrl: request.nextUrl.toString(), leadName }));
  }

  if (digits !== "1") {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Not recognized. Goodbye.</Say>
</Response>`,
      200
    );
  }

  const statusCallbackUrl = new URL("/api/webhooks/twilio/call-status", request.nextUrl.origin);
  statusCallbackUrl.searchParams.set("leg", "customer");
  statusCallbackUrl.searchParams.set("mode", "sales_escalation");
  const dialActionUrl = new URL("/api/webhooks/twilio/dial-action", request.nextUrl.origin);
  dialActionUrl.searchParams.set("leg", "customer");
  dialActionUrl.searchParams.set("mode", "sales_escalation");

  return twimlResponse(
    buildConnectTwiML({
      to,
      callerId,
      statusCallbackUrl: statusCallbackUrl.toString(),
      dialActionUrl: dialActionUrl.toString()
    })
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const leadName = request.nextUrl.searchParams.get("name");
  return twimlResponse(buildGatherTwiML({ actionUrl: request.nextUrl.toString(), leadName }));
}
