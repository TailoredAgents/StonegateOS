import type { NextRequest } from "next/server";
import { mutateOwnerAlerts } from "@/lib/partner-owner-alert-routes";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ groupId?: string }> },
) {
  return mutateOwnerAlerts(
    request,
    "group_opened",
    (await context.params).groupId,
  );
}
