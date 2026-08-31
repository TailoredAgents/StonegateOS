import type { NextRequest } from "next/server";
import { handleRevokeQuoteV2Capability } from "@/lib/quote-v2-capability-route";

export function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string; capabilityId?: string }> },
): Promise<Response> {
  return handleRevokeQuoteV2Capability(request, context);
}
