import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { callPartnerPublicApi } from "../lib/api";

export async function POST(request: NextRequest): Promise<Response> {
  const token = request.cookies.get(PARTNER_SESSION_COOKIE)?.value ?? "";
  if (token) {
    await callPartnerPublicApi("/api/portal/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => null);
  }

  const response = NextResponse.redirect(new URL("/partners/login", request.url));
  response.cookies.set({
    name: PARTNER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}

