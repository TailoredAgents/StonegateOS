import type { NextRequest } from "next/server";
import { mutateOwnerAlerts } from "@/lib/partner-owner-alert-routes";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ bookingId?: string }> },
) {
  return mutateOwnerAlerts(
    request,
    "request_opened",
    (await context.params).bookingId,
  );
}
