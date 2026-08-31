import type { NextRequest } from "next/server";
import {
  quoteV2ErrorResponse,
  quoteV2CorrelationId,
} from "@/lib/quote-v2-http";
import { maybeHandleQuoteV2VisibleEngagement } from "@/lib/quote-v2-public-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const result = await maybeHandleQuoteV2VisibleEngagement(
    request,
    token ?? "",
  );
  if (result.handled) return result.response;
  return quoteV2ErrorResponse("not_found", "This proposal was not found.", {
    correlationId: quoteV2CorrelationId(request),
  });
}
