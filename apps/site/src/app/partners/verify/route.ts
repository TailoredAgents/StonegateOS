import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callPartnerPublicApi } from "@/app/partners/lib/api";
import { resolvePublicOrigin } from "@/app/partners/lib/origin";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";

function failureRedirect(origin: string, code: string): NextResponse {
  const destination = new URL("/partners/request-access", origin);
  destination.searchParams.set("error", code);
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    return failureRedirect(origin, "invalid_or_expired");
  }

  const upstream = await callPartnerPublicApi(
    "/api/portal/v2/onboarding/email-challenges/consume",
    {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ token }),
      timeoutMs: 20_000,
    },
  ).catch(() => null);
  if (!upstream?.ok) {
    return failureRedirect(
      origin,
      upstream && upstream.status >= 500
        ? "temporarily_unavailable"
        : "invalid_or_expired",
    );
  }

  const payload = (await upstream.json().catch(() => null)) as {
    sessionToken?: string;
    expiresAt?: string;
  } | null;
  const sessionToken = payload?.sessionToken?.trim() ?? "";
  const expiresAt = new Date(payload?.expiresAt ?? "");
  if (
    !sessionToken ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return failureRedirect(origin, "temporarily_unavailable");
  }

  const destination = new URL("/partners/application", origin);
  destination.searchParams.set("verified", "1");
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set({
    name: PARTNER_APPLICATION_SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
