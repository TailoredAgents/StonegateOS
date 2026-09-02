import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  callPartnerApplicantApi,
  callPartnerPublicApi,
} from "@/app/partners/lib/api";
import {
  PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE,
  PARTNER_ACTIVATION_TOKEN_COOKIE,
  PARTNER_APPLICATION_SESSION_COOKIE,
  PARTNER_EMAIL_CHANGE_TOKEN_COOKIE,
  PARTNER_PASSWORD_RESET_TOKEN_COOKIE,
} from "@/lib/partner-application-session";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";

const MAX_BODY_BYTES = 32 * 1024;
const SAFE_SEGMENT = /^[a-z][a-z0-9-]{0,63}$/u;
const PUBLIC_ENDPOINTS = new Set([
  "email-challenges",
  "email-challenges/consume",
  "activation/inspect",
  "activation/complete",
  "activation/mfa/enrollment",
  "activation/mfa/confirm",
  "password-recovery/request",
  "password-recovery/complete",
  "email-change/confirm",
]);
const APPLICANT_ENDPOINTS = new Set([
  "application",
  "application/submit",
  "application/respond",
  "application/withdraw",
  "activation/resend",
]);
const ALLOWED_METHODS: Record<string, readonly string[]> = {
  "email-challenges": ["POST"],
  "email-challenges/consume": ["POST"],
  application: ["GET", "PATCH"],
  "application/submit": ["POST"],
  "application/respond": ["POST"],
  "application/withdraw": ["POST"],
  "activation/inspect": ["POST"],
  "activation/complete": ["POST"],
  "activation/mfa/enrollment": ["POST"],
  "activation/mfa/confirm": ["POST"],
  "activation/resend": ["POST"],
  "password-recovery/request": ["POST"],
  "password-recovery/complete": ["POST"],
  "email-change/confirm": ["POST"],
};
const REQUEST_HEADERS = [
  "content-type",
  "idempotency-key",
  "if-match",
  "x-correlation-id",
] as const;
const RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "retry-after",
  "x-correlation-id",
  "idempotency-replayed",
] as const;

function mutationOriginAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin) return origin === request.nextUrl.origin;
  return fetchSite === "same-origin" || fetchSite === "none";
}

async function boundedBody(request: NextRequest): Promise<ArrayBuffer | null> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    /^\d+$/u.test(declared) &&
    Number(declared) > MAX_BODY_BYTES
  ) {
    return null;
  }
  const body = await request.arrayBuffer();
  return body.byteLength <= MAX_BODY_BYTES ? body : null;
}

function validExpiry(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now()
    ? date
    : null;
}

function deleteApplicationCookie(response: NextResponse): void {
  response.cookies.set({
    name: PARTNER_APPLICATION_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

function deletePurposeTokenCookie(response: NextResponse, name: string): void {
  response.cookies.set({
    name,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

function deleteActivationMfaCookie(response: NextResponse): void {
  response.cookies.set({
    name: PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

function bodyWithPurposeToken(
  endpoint: string,
  rawBody: ArrayBuffer,
  request: NextRequest,
): ArrayBuffer {
  const cookieName =
    endpoint === "activation/inspect" || endpoint === "activation/complete"
      ? PARTNER_ACTIVATION_TOKEN_COOKIE
      : endpoint === "password-recovery/complete"
        ? PARTNER_PASSWORD_RESET_TOKEN_COOKIE
        : endpoint === "email-change/confirm"
          ? PARTNER_EMAIL_CHANGE_TOKEN_COOKIE
          : null;
  if (!cookieName) return rawBody;
  let payload: Record<string, unknown> = {};
  if (rawBody.byteLength) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
  }
  const token = request.cookies.get(cookieName)?.value?.trim() ?? "";
  return new TextEncoder().encode(JSON.stringify({ ...payload, token })).buffer;
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  const method = request.method.toUpperCase();
  const { segments } = await context.params;
  if (
    !Array.isArray(segments) ||
    segments.length < 1 ||
    segments.length > 3 ||
    segments.some((segment) => !SAFE_SEGMENT.test(segment))
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request",
        message: "The onboarding path is invalid.",
      },
      { status: 400 },
    );
  }
  const endpoint = segments.join("/");
  const allowed = ALLOWED_METHODS[endpoint];
  if (!allowed?.includes(method)) {
    return NextResponse.json(
      {
        ok: false,
        error: "method_not_allowed",
        message: "This request method is not supported.",
      },
      { status: 405, headers: { Allow: allowed?.join(", ") ?? "" } },
    );
  }
  if (method !== "GET" && !mutationOriginAllowed(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        message: "The request origin could not be verified.",
      },
      { status: 403 },
    );
  }

  const rawBody =
    method === "GET" ? new ArrayBuffer(0) : await boundedBody(request);
  if (!rawBody) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        message: "The request body is too large.",
      },
      { status: 413 },
    );
  }
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (method !== "GET") headers.set("Origin", request.nextUrl.origin);
  headers.set(
    "X-Forwarded-Proto",
    request.nextUrl.protocol === "https:" ? "https" : "http",
  );
  const forwardedIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  if (forwardedIp) headers.set("X-Forwarded-For", forwardedIp.slice(0, 128));
  const userAgent = request.headers.get("user-agent")?.trim();
  if (userAgent) headers.set("User-Agent", userAgent.slice(0, 512));
  if (endpoint.startsWith("activation/mfa/")) {
    const transactionToken =
      request.cookies
        .get(PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE)
        ?.value?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(transactionToken)) {
      return NextResponse.json(
        {
          ok: false,
          error: "unauthorized",
          message: "The security setup session has expired.",
        },
        {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    headers.set("Authorization", `Bearer ${transactionToken}`);
  }

  const caller = APPLICANT_ENDPOINTS.has(endpoint)
    ? callPartnerApplicantApi
    : PUBLIC_ENDPOINTS.has(endpoint)
      ? callPartnerPublicApi
      : null;
  if (!caller) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
        message: "The onboarding endpoint was not found.",
      },
      { status: 404 },
    );
  }
  const upstreamBody = bodyWithPurposeToken(endpoint, rawBody, request);
  const upstream = await caller(`/api/portal/v2/onboarding/${endpoint}`, {
    method,
    headers,
    ...(upstreamBody.byteLength ? { body: upstreamBody } : {}),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!upstream) {
    return NextResponse.json(
      {
        ok: false,
        error: "service_unavailable",
        message: "Partner onboarding is temporarily unavailable.",
        retryable: true,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const bytes = await upstream.arrayBuffer();
  const responseHeaders = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
  });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  if (endpoint === "activation/complete" && upstream.ok) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<
        string,
        unknown
      >;
    } catch {
      payload = null;
    }
    const transactionToken =
      typeof payload?.["transactionToken"] === "string"
        ? payload["transactionToken"].trim()
        : "";
    const transactionExpiry = validExpiry(payload?.["expiresAt"]);
    const needsMfaSetup =
      payload?.["status"] === "mfa_setup_required" &&
      payload?.["authority"] === "pre_authentication_only";
    if (needsMfaSetup) {
      if (
        !/^[A-Za-z0-9_-]{43}$/u.test(transactionToken) ||
        !transactionExpiry ||
        transactionExpiry.getTime() - Date.now() > 10 * 60 * 1_000
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "invalid_response",
            message:
              "Activation did not return a valid security setup session.",
          },
          { status: 502, headers: responseHeaders },
        );
      }
      const response = NextResponse.json(
        {
          ...payload,
          transactionToken: undefined,
          redirectTo: "/partners/activate/mfa",
        },
        { status: upstream.status, headers: responseHeaders },
      );
      response.cookies.set({
        name: PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE,
        value: transactionToken,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        expires: transactionExpiry,
      });
      deleteApplicationCookie(response);
      deletePurposeTokenCookie(response, PARTNER_ACTIVATION_TOKEN_COOKIE);
      return response;
    }
    const sessionToken =
      typeof payload?.["sessionToken"] === "string"
        ? payload["sessionToken"].trim()
        : "";
    const expiresAt = validExpiry(payload?.["expiresAt"]);
    if (!sessionToken || !expiresAt) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_response",
          message: "Activation completed without a valid portal session.",
        },
        { status: 502, headers: responseHeaders },
      );
    }
    const securitySetupOnly =
      payload?.["nextAction"] === "mfa_enrollment_required" ||
      payload?.["authority"] === "security_setup_only" ||
      payload?.["mfaRequired"] === true;
    const safePayload = {
      ...payload,
      sessionToken: undefined,
      redirectTo: securitySetupOnly
        ? "/partners/settings#two-step-verification"
        : "/partners/overview",
    };
    const response = NextResponse.json(safePayload, {
      status: upstream.status,
      headers: responseHeaders,
    });
    response.cookies.set({
      name: PARTNER_SESSION_COOKIE,
      value: sessionToken,
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    deleteApplicationCookie(response);
    deletePurposeTokenCookie(response, PARTNER_ACTIVATION_TOKEN_COOKIE);
    return response;
  }

  if (endpoint === "activation/mfa/confirm" && upstream.ok) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<
        string,
        unknown
      >;
    } catch {
      payload = null;
    }
    const sessionToken =
      typeof payload?.["sessionToken"] === "string"
        ? payload["sessionToken"].trim()
        : "";
    const expiresAt = validExpiry(payload?.["expiresAt"]);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionToken) || !expiresAt) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_response",
          message: "Security setup completed without a valid portal session.",
        },
        { status: 502, headers: responseHeaders },
      );
    }
    const response = NextResponse.json(
      {
        ...payload,
        sessionToken: undefined,
        redirectTo: "/partners/overview",
      },
      { status: upstream.status, headers: responseHeaders },
    );
    response.cookies.set({
      name: PARTNER_SESSION_COOKIE,
      value: sessionToken,
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    deleteActivationMfaCookie(response);
    return response;
  }

  const response = new NextResponse(bytes, {
    status: upstream.status,
    headers: responseHeaders,
  });
  if (APPLICANT_ENDPOINTS.has(endpoint) && upstream.status === 401) {
    deleteApplicationCookie(response);
  }
  if (
    endpoint === "password-recovery/complete" &&
    (upstream.ok || upstream.status === 401 || upstream.status === 410)
  ) {
    deletePurposeTokenCookie(response, PARTNER_PASSWORD_RESET_TOKEN_COOKIE);
  }
  if (
    endpoint === "email-change/confirm" &&
    (upstream.ok ||
      upstream.status === 401 ||
      upstream.status === 409 ||
      upstream.status === 410)
  ) {
    deletePurposeTokenCookie(response, PARTNER_EMAIL_CHANGE_TOKEN_COOKIE);
    if (upstream.ok) {
      deletePurposeTokenCookie(response, PARTNER_SESSION_COOKIE);
    }
  }
  if (
    (endpoint === "activation/inspect" || endpoint === "activation/complete") &&
    (upstream.status === 401 || upstream.status === 410)
  ) {
    deletePurposeTokenCookie(response, PARTNER_ACTIVATION_TOKEN_COOKIE);
  }
  if (
    endpoint.startsWith("activation/mfa/") &&
    (upstream.status === 401 || upstream.status === 410)
  ) {
    deleteActivationMfaCookie(response);
  }
  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
