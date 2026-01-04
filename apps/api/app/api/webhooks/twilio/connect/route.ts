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

function buildTwiML(input: { to: string; callerId: string }): string {
  const to = escapeXml(input.to);
  const callerId = escapeXml(input.callerId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}">
    <Number>${to}</Number>
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
    return NextResponse.json({ error: "missing_to_or_from" }, { status: 400 });
  }

  return twimlResponse(buildTwiML({ to, callerId }));
}

export async function POST(request: NextRequest): Promise<Response> {
  return GET(request);
}

