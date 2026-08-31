import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { handleQuoteV2ChangeResolution } from "@/lib/quote-v2-staff-lifecycle-route";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string; requestId?: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, "quotes.update");
  if (permissionError) return permissionError;
  return handleQuoteV2ChangeResolution(request, context);
}
