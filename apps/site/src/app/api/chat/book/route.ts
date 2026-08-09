import type { NextRequest } from "next/server";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";
import { POST as executeApprovedAgentAction } from "../actions/route";

/**
 * Compatibility alias for older Agent booking cards. Booking now uses the
 * same explicit-approval, idempotency, receipt, and principal checks as every
 * other Agent-proposed write. The shared executor independently verifies the
 * current session again at the moment of execution.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRequestPrincipal(request, {
    returnJson: true,
    permissions: "bookings.manage",
    flashError: "You do not have permission to book an appointment.",
  });
  if (!auth.ok) return auth.response;

  return executeApprovedAgentAction(request);
}
