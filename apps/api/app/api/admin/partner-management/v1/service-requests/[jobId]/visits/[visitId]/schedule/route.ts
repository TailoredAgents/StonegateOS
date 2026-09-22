import type { NextRequest } from "next/server";
import { partnerMultiServiceMutationRoute } from "@/lib/partner-multi-service-route";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId?: string; visitId?: string }> },
) {
  return partnerMultiServiceMutationRoute(request, context, "visit_reschedule");
}
