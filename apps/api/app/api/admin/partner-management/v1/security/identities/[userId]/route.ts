import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getPartnerIdentitySecurityImpact } from "@/lib/partner-identity-security-administration";
import { requirePermission } from "@/lib/permissions";

type RouteContext = { params: Promise<{ userId?: string }> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  // This inventory enumerates every company affected by an owner-only global
  // action, so the owner-only permission is deliberately stronger than the
  // ordinary session-directory read permission.
  const permissionError = await requirePermission(
    request,
    "partners.identities.disable",
  );
  if (permissionError) return permissionError;

  const { userId: rawUserId } = await context.params;
  const partnerUserId = rawUserId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(partnerUserId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_partner_identity",
        message: "Choose a valid partner identity.",
      },
      { status: 422, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const impact = await getPartnerIdentitySecurityImpact(partnerUserId);
    if (!impact) {
      return NextResponse.json(
        {
          ok: false,
          error: "not_found",
          message: "The partner identity was not found.",
        },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, impact },
      {
        headers: {
          ...NO_STORE_HEADERS,
          ETag: `"${impact.identity.version}"`,
        },
      },
    );
  } catch (error) {
    console.error("[partner-management] identity_security_impact_failed", {
      partnerUserId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_identity_security_unavailable",
        message: "The identity security impact could not be loaded.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
