import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exchangePartnerLoginToken } from "@/lib/partner-portal-auth";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";

export async function POST(request: NextRequest): Promise<Response> {
  let payload: unknown;
  try {
    payload = await readBoundedJsonRequest(request, { maximumBytes: 1024 });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request could not be read.",
            400,
          );
    return NextResponse.json(
      { ok: false, error: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).join(",") !== "token"
  ) {
    return NextResponse.json(
      { ok: false, error: "token_required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rawTokenValue = (payload as Record<string, unknown>)["token"];
  const rawToken =
    typeof rawTokenValue === "string" ? rawTokenValue.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(rawToken)) {
    return NextResponse.json(
      { ok: false, error: "token_required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  let result: Awaited<ReturnType<typeof exchangePartnerLoginToken>>;
  try {
    result = await exchangePartnerLoginToken(rawToken, request, 30);
  } catch {
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!result) {
    return NextResponse.json(
      { ok: false, error: "invalid_or_expired" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      sessionToken: result.sessionToken,
      needsPasswordSetup: result.needsPasswordSetup,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
