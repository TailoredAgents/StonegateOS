import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isValidPartnerPurposeToken,
  partnerPurposeTokenPolicy,
} from "@/app/partners/lib/public-route-policy";
import { ADMIN_SESSION_COOKIE, adminSessionMatches } from "@/lib/admin-session";

const COOKIE_NAME = "myst_utm";
const ADMIN_LOGIN_PATH = "/admin/login";
const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
];

type UtmCookie = Record<string, string>;

function parseCookie(value: string | undefined): UtmCookie {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as UtmCookie;
    }
  } catch {
    // Ignore malformed attribution cookies and replace them with safe values.
  }
  return {};
}

function applySensitivePartnerHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith("/partners")) {
    const tokenPolicy = partnerPurposeTokenPolicy(pathname);
    const rawToken = tokenPolicy
      ? (request.nextUrl.searchParams.get("token")?.trim() ?? "")
      : "";

    if (tokenPolicy && request.nextUrl.searchParams.has("token")) {
      const destination = request.nextUrl.clone();
      destination.searchParams.delete("token");
      const response = NextResponse.redirect(destination, 303);

      if (isValidPartnerPurposeToken(rawToken)) {
        response.cookies.set({
          name: tokenPolicy.cookieName,
          value: rawToken,
          httpOnly: true,
          secure: process.env["NODE_ENV"] === "production",
          sameSite: "lax",
          path: "/",
          maxAge: tokenPolicy.maximumAgeSeconds,
        });
      } else {
        response.cookies.delete(tokenPolicy.cookieName);
      }

      return applySensitivePartnerHeaders(response);
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(
      "x-partner-return-to",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return tokenPolicy ? applySensitivePartnerHeaders(response) : response;
  }

  if (pathname.startsWith("/admin")) {
    if (
      pathname === ADMIN_LOGIN_PATH ||
      adminSessionMatches(request.cookies.get(ADMIN_SESSION_COOKIE)?.value)
    ) {
      return NextResponse.next();
    }
    const loginUrl = new URL(ADMIN_LOGIN_PATH, request.url);
    loginUrl.searchParams.set(
      "redirectTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  const url = request.nextUrl;
  const hasTrackingParams = UTM_PARAMS.some((param) =>
    url.searchParams.has(param),
  );

  if (!hasTrackingParams) {
    return response;
  }

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  const enriched: UtmCookie = { ...parseCookie(cookieValue) };

  for (const param of UTM_PARAMS) {
    const value = url.searchParams.get(param);
    if (value) {
      const normalizedKey = param.replace(/^utm_/, "");
      enriched[normalizedKey] = value;
    }
  }

  response.cookies.set({
    name: COOKIE_NAME,
    value: JSON.stringify(enriched),
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    path: "/",
  });

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
