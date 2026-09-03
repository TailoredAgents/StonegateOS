import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isValidPartnerPurposeToken,
  partnerLandingDestination,
  type PartnerLandingPortalState,
  partnerPurposeTokenPolicy,
} from "@/app/partners/lib/public-route-policy";
import { resolvePartnerApiUrl } from "@/app/partners/lib/api-origin";
import { ADMIN_SESSION_COOKIE, adminSessionMatches } from "@/lib/admin-session";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";
import {
  isValidPartnerSessionToken,
  PARTNER_SESSION_COOKIE,
} from "@/lib/partner-session";

const COOKIE_NAME = "myst_utm";
const ADMIN_LOGIN_PATH = "/admin/login";
const PARTNER_LANDING_PATH = "/partners";
const PARTNER_UNAVAILABLE_PATH = "/partners/unavailable";
const PARTNER_SESSION_CHECK_TIMEOUT_MS = 2_000;
const PARTNER_INTERNAL_DEGRADED_HEADER = "x-partner-internal-degraded";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

function applyPartnerUnavailableHeaders(response: NextResponse): NextResponse {
  applySensitivePartnerHeaders(response);
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

function clearPartnerSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: PARTNER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

type PartnerLandingSessionProbeOptions = {
  apiUrl?: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isAuthenticatedPartnerSessionResponse(
  response: Response,
): Promise<boolean> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || payload["ok"] !== true) return false;
  const session = payload["session"];
  return (
    isRecord(session) &&
    session["current"] === true &&
    typeof payload["currentAccountId"] === "string" &&
    UUID_PATTERN.test(payload["currentAccountId"]) &&
    typeof payload["currentMembershipId"] === "string" &&
    UUID_PATTERN.test(payload["currentMembershipId"])
  );
}

/**
 * Resolves an opaque browser cookie against the account-scoped session API.
 * Cookie presence is never treated as authentication, and transient provider
 * failures remain distinct from definitive session rejection.
 */
export async function resolvePartnerLandingSessionState(
  rawToken: string,
  options: PartnerLandingSessionProbeOptions = {},
): Promise<PartnerLandingPortalState> {
  if (!rawToken) return "absent";
  if (!isValidPartnerSessionToken(rawToken)) return "unauthenticated";

  const apiUrl = Object.prototype.hasOwnProperty.call(options, "apiUrl")
    ? options.apiUrl
    : resolvePartnerApiUrl("/api/portal/v2/session");
  if (!apiUrl) return "unavailable";

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PARTNER_SESSION_CHECK_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetcher ?? fetch)(apiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${rawToken}`,
        "x-correlation-id": `portal_${globalThis.crypto
          .randomUUID()
          .replace(/-/gu, "")}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 200) {
      return (await isAuthenticatedPartnerSessionResponse(response))
        ? "authenticated"
        : "unavailable";
    }
    if (response.status === 401 || response.status === 403) {
      return "unauthenticated";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function partnerLandingResponse(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (
    request.nextUrl.pathname !== PARTNER_LANDING_PATH ||
    !["GET", "HEAD"].includes(request.method.toUpperCase())
  ) {
    return null;
  }

  const rawSessionToken =
    request.cookies.get(PARTNER_SESSION_COOKIE)?.value ?? "";
  const portalState = await resolvePartnerLandingSessionState(rawSessionToken);
  const applicationSessionPresent = Boolean(
    request.cookies.get(PARTNER_APPLICATION_SESSION_COOKIE)?.value,
  );
  const destination = partnerLandingDestination({
    applicationSessionPresent,
    portalState,
  });

  if (destination) {
    const response = NextResponse.redirect(
      new URL(destination, request.url),
      307,
    );
    if (portalState === "unauthenticated" && rawSessionToken) {
      clearPartnerSessionCookie(response);
    }
    return applySensitivePartnerHeaders(response);
  }

  if (portalState === "unavailable") {
    const destination = request.nextUrl.clone();
    destination.pathname = PARTNER_UNAVAILABLE_PATH;
    destination.search = "";
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete(PARTNER_INTERNAL_DEGRADED_HEADER);
    requestHeaders.set(PARTNER_INTERNAL_DEGRADED_HEADER, "1");
    return applyPartnerUnavailableHeaders(
      NextResponse.rewrite(destination, {
        request: { headers: requestHeaders },
      }),
    );
  }

  if (portalState === "unauthenticated" && rawSessionToken) {
    const response = NextResponse.next();
    clearPartnerSessionCookie(response);
    return applySensitivePartnerHeaders(response);
  }

  // A truly anonymous request passes through untouched so Next can serve the
  // statically generated, indexable landing response from its public cache.
  if (request.headers.has(PARTNER_INTERNAL_DEGRADED_HEADER)) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete(PARTNER_INTERNAL_DEGRADED_HEADER);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  return NextResponse.next();
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith("/partners")) {
    if (pathname === PARTNER_UNAVAILABLE_PATH) {
      return applyPartnerUnavailableHeaders(
        NextResponse.redirect(new URL(PARTNER_LANDING_PATH, request.url), 307),
      );
    }

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

    const landingResponse = await partnerLandingResponse(request);
    if (landingResponse) return landingResponse;

    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete(PARTNER_INTERNAL_DEGRADED_HEADER);
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
