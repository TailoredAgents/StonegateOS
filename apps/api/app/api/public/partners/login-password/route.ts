import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loginWithPassword, normalizeEmail } from "@/lib/partner-portal-auth";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

export async function POST(request: NextRequest): Promise<Response> {
  let payload: unknown;
  try {
    payload = await readBoundedJsonRequest(request, { maximumBytes: 2 * 1024 });
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
    Object.keys(payload).sort().join(",") !== "email,password"
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const record = payload as Record<string, unknown>;
  const email = normalizeEmail(record["email"]);
  const password =
    typeof record["password"] === "string" ? record["password"] : null;
  if (!email || email.length > 320 || !password || password.length > 256) {
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_password_login",
      request,
      identity: { kind: "email", value: email },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
  if (rateLimit.limited) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  let session: Awaited<ReturnType<typeof loginWithPassword>>;
  try {
    session = await loginWithPassword(email, password, request, 30);
  } catch {
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, sessionToken: session.sessionToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}
