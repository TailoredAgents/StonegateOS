import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PUBLIC_QUOTE_HEADERS } from "@/lib/quote-v2-http";
import { maybeHandleQuoteV2PublicAttachment } from "@/lib/quote-v2-public-route";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; attachmentId: string }> },
): Promise<Response> {
  const { token, attachmentId } = await context.params;
  if (!UUID_PATTERN.test(attachmentId)) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: PUBLIC_QUOTE_HEADERS },
    );
  }
  const v2 = await maybeHandleQuoteV2PublicAttachment(
    request,
    token,
    attachmentId,
  );
  if (v2.handled) return v2.response;
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: PUBLIC_QUOTE_HEADERS },
  );
}
