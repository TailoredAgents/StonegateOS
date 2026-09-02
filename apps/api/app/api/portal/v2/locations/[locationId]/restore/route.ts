import type { NextRequest } from "next/server";
import { handlePartnerLocationMergeMutation } from "@/lib/partner-location-merge-route";

type RouteContext = { params: Promise<{ locationId: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { locationId } = await context.params;
  return handlePartnerLocationMergeMutation(request, {
    locationId,
    mode: "restore",
  });
}
