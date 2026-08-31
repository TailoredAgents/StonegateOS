import type { NextRequest } from "next/server";
import { handleReplaceQuoteV2Capability } from "@/lib/quote-v2-capability-route";

export function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string; capabilityId?: string }> },
): Promise<Response> {
  return handleReplaceQuoteV2Capability(request, context);
}
