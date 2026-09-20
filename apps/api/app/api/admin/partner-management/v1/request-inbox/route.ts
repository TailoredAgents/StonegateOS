import { NextResponse, type NextRequest } from "next/server";
import { resolvePermissionContext } from "@/lib/permissions";
import {
  listPartnerRequestInbox,
  PartnerRequestInboxError,
} from "@/lib/partner-request-inbox";

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = crypto.randomUUID();
  const context = await resolvePermissionContext(request);
  if (!context.authenticated)
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers },
    );
  try {
    return NextResponse.json(
      await listPartnerRequestInbox(request.nextUrl.searchParams, context),
      { headers },
    );
  } catch (error) {
    if (error instanceof PartnerRequestInboxError)
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.status, headers },
      );
    console.error("[partner.request_inbox] read_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "temporarily_unavailable",
        message: "Requests could not be loaded. Try again.",
        correlationId,
      },
      {
        status: 503,
        headers: { ...headers, "x-correlation-id": correlationId },
      },
    );
  }
}
