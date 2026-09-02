import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolvePublicOrigin } from "@/app/partners/lib/origin";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";

export function GET(request: NextRequest): Response {
  const destination = new URL(
    "/partners/request-access",
    resolvePublicOrigin(request),
  );
  destination.searchParams.set("error", "invalid_or_expired");
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set({
    name: PARTNER_APPLICATION_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
