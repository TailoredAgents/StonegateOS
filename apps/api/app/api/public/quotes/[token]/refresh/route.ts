import type { NextRequest } from "next/server";
import {
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
} from "@/lib/quote-v2-http";
import { maybeHandleQuoteV2PublicRefresh } from "@/lib/quote-v2-public-route";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = quoteV2CorrelationId(request);
  const { token } = await context.params;
  if (!token) {
    return quoteV2ErrorResponse("invalid", "A proposal link is required.", {
      correlationId,
    });
  }
  const result = await maybeHandleQuoteV2PublicRefresh(request, token);
  if (result.handled) return result.response;
  return quoteV2ErrorResponse("not_found", "This proposal was not found.", {
    correlationId,
  });
}
