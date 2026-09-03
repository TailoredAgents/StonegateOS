import { cookies } from "next/headers";
import {
  isValidPartnerSessionToken,
  PARTNER_SESSION_COOKIE,
} from "@/lib/partner-session";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";
import { resolvePartnerApiUrl } from "./api-origin";

type CallApiInit = RequestInit & { timeoutMs?: number };

function mergeHeaders(
  defaults: HeadersInit,
  incoming?: HeadersInit,
  overrides?: HeadersInit,
): Headers {
  const headers = new Headers(defaults);
  if (incoming) {
    new Headers(incoming).forEach((value, key) => headers.set(key, value));
  }
  if (overrides) {
    new Headers(overrides).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

export async function callPartnerPublicApi(
  path: string,
  init?: CallApiInit,
): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error("Partner API paths must be absolute.");
  }
  const apiUrl = resolvePartnerApiUrl(path as `/${string}`);
  if (!apiUrl) {
    throw new Error("Partner API base URL is unavailable.");
  }
  const { timeoutMs = 25_000, ...requestInit } = init ?? {};
  const isFormDataBody =
    typeof FormData !== "undefined" && requestInit?.body instanceof FormData;
  const defaultHeaders: Record<string, string> = isFormDataBody
    ? {}
    : { "Content-Type": "application/json" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(apiUrl, {
      ...requestInit,
      signal: controller.signal,
      headers: mergeHeaders(defaultHeaders, requestInit.headers),
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callPartnerApi(
  path: string,
  init?: CallApiInit,
): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(PARTNER_SESSION_COOKIE)?.value ?? "";
  if (!isValidPartnerSessionToken(token)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return callPartnerPublicApi(path, {
    ...init,
    headers: mergeHeaders({}, init?.headers, {
      Authorization: `Bearer ${token}`,
    }),
  });
}

export async function callPartnerApplicantApi(
  path: string,
  init?: CallApiInit,
): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(PARTNER_APPLICATION_SESSION_COOKIE)?.value ?? "";
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return callPartnerPublicApi(path, {
    ...init,
    headers: mergeHeaders({}, init?.headers, {
      Authorization: `Bearer ${token}`,
    }),
  });
}
