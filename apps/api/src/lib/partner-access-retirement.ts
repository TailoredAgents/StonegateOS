import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readPortalV2CorrelationId } from "./portal-v2-contract";

/** Existing relationships are provisioned by staff or invited by their company. */
export function partnerAccessWorkflowRetired(request: NextRequest): Response {
  const correlationId = readPortalV2CorrelationId(request.headers);
  return NextResponse.json(
    {
      ok: false,
      error: "workflow_retired",
      code: "workflow_retired",
      message:
        "For partner access or help, email sales@stonegatejunkremoval.com or call 404-777-2631. Existing requests are preserved.",
      correlationId,
      retryable: false,
      recoveryActions: [
        {
          kind: "contact_support",
          href: "mailto:sales@stonegatejunkremoval.com",
        },
      ],
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "x-correlation-id": correlationId,
      },
    },
  );
}
