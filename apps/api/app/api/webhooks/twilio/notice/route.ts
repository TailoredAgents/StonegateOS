import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCompanyProfilePolicy } from "@/lib/policy";

export const dynamic = "force-dynamic";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    }
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

  const safe = escapeXml(trimmed.slice(0, 400));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${safe}</Say>
</Response>`;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const xml = await buildNoticeTwiML(request);
    return twimlResponse(xml, 200);
  } catch (error) {
    console.warn("[twilio.notice] failed", { error: String(error) });
    return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, 200);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return GET(request);
}

