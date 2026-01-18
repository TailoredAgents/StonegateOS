import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { normalizePhone } from "../../../web/utils";

export const dynamic = "force-dynamic";

function resolveFallbackOrigin(request: NextRequest): string {
  const proto = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0]?.trim() || "https";
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  if (host) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}

function resolvePublicApiBaseUrl(fallbackOrigin: string): string {
  const raw = (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").trim();
  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      const lowered = url.hostname.toLowerCase();
      const isLocalhost =
        lowered === "localhost" ||
        lowered === "0.0.0.0" ||
        lowered === "127.0.0.1" ||
        lowered.endsWith(".internal");
      if (process.env["NODE_ENV"] === "production" && isLocalhost) {
        return fallbackOrigin;
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      return fallbackOrigin;
    }
  }

  return fallbackOrigin;
}

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

function buildTwiML(input: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  dialActionUrl: string;
  noticeUrl: string;
}): string {
  const to = escapeXml(input.to);
  const callerId = escapeXml(input.callerId);
  const statusCallbackUrl = escapeXml(input.statusCallbackUrl);
  const dialActionUrl = escapeXml(input.dialActionUrl);
  const noticeUrl = escapeXml(input.noticeUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" action="${dialActionUrl}" method="POST" answerOnBridge="true" record="record-from-answer">
    <Number url="${noticeUrl}" statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
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
  const publicApiBaseUrl = resolvePublicApiBaseUrl(resolveFallbackOrigin(request));
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

  const statusCallbackUrl = new URL("/api/webhooks/twilio/call-status", publicApiBaseUrl);
  statusCallbackUrl.searchParams.set("leg", "customer");
  const dialActionUrl = new URL("/api/webhooks/twilio/dial-action", publicApiBaseUrl);
  dialActionUrl.searchParams.set("leg", "customer");
  const noticeUrl = new URL("/api/webhooks/twilio/notice", publicApiBaseUrl);
  noticeUrl.searchParams.set("kind", "outbound");

  return twimlResponse(
    buildTwiML({
      to,
      callerId,
      statusCallbackUrl: statusCallbackUrl.toString(),
      dialActionUrl: dialActionUrl.toString(),
      noticeUrl: noticeUrl.toString()
    })
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  return GET(request);
}
