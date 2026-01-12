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

function buildTwiML(input: { to: string; callerId: string; statusCallbackUrl: string }): string {
  const to = escapeXml(input.to);
  const callerId = escapeXml(input.callerId);
  const statusCallbackUrl = escapeXml(input.statusCallbackUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}">
    <Number statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    }
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const to = resolveDialTarget(request);
  const callerId = process.env["TWILIO_FROM"] ?? null;
  if (!to || !callerId) {
    console.warn("[twilio.connect] missing_to_or_from", {
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

  const statusCallbackUrl = new URL("/api/webhooks/twilio/call-status", request.nextUrl.origin);
  statusCallbackUrl.searchParams.set("leg", "customer");

  return twimlResponse(buildTwiML({ to, callerId, statusCallbackUrl: statusCallbackUrl.toString() }));
}

export async function POST(request: NextRequest): Promise<Response> {
  return GET(request);
}
