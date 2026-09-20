import { NextResponse, type NextRequest } from "next/server";
import { PARTNER_REQUEST_KINDS, type PartnerRequestKind } from "@myst-os/sdk";
import { resolvePermissionContext } from "@/lib/permissions";
import {
  getPartnerRequestInboxItem,
  PartnerRequestInboxError,
} from "@/lib/partner-request-inbox";

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; requestId: string }> },
): Promise<Response> {
  const context = await resolvePermissionContext(request);
  if (!context.authenticated)
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers },
    );
  const { kind, requestId } = await params;
  const query = request.nextUrl.searchParams;
  if (
    !PARTNER_REQUEST_KINDS.includes(kind as PartnerRequestKind) ||
    query.getAll("accountId").length > 1 ||
    [...query.keys()].some((key) => key !== "accountId")
  )
    return NextResponse.json(
      { ok: false, error: "invalid_fields" },
      { status: 422, headers },
    );
  try {
    return NextResponse.json(
      await getPartnerRequestInboxItem(
        kind as PartnerRequestKind,
        requestId,
        query.get("accountId") ?? "",
        context,
      ),
      { headers },
    );
  } catch (error) {
    if (error instanceof PartnerRequestInboxError)
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.status, headers },
      );
    const correlationId = crypto.randomUUID();
    console.error("[partner.request_inbox] detail_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "temporarily_unavailable",
        message: "This request could not be loaded. Try again.",
        correlationId,
      },
      {
        status: 503,
        headers: { ...headers, "x-correlation-id": correlationId },
      },
    );
  }
}
