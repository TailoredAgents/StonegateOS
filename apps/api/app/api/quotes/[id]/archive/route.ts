import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { handleQuoteV2Archive } from "@/lib/quote-v2-staff-lifecycle-route";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, "quotes.update");
  if (permissionError) return permissionError;
  return handleQuoteV2Archive(request, context);
}
