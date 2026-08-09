import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCompanyProfilePolicy } from "@/lib/policy";
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

async function buildNoticeTwiML(request: NextRequest): Promise<string> {
  const kind = request.nextUrl.searchParams.get("kind")?.trim() || "outbound";
  if (kind !== "outbound") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  }

  const profile = await getCompanyProfilePolicy();
  const notice = profile.outboundCallRecordingNotice ?? "";
  const trimmed = notice.trim();
  if (!trimmed) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  }

  const safe = escapeTwilioXmlText(trimmed.slice(0, 400));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${safe}</Say>
</Response>`;
}

async function handleVerifiedRequest(request: NextRequest): Promise<Response> {
  try {
    const xml = await buildNoticeTwiML(request);
    return twimlResponse(xml, 200);
  } catch (error) {
    console.warn("[twilio.notice] failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
      200,
    );
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  return handleVerifiedRequest(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  return handleVerifiedRequest(request);
}
