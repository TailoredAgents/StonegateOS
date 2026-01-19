import { cookies } from "next/headers";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

type CallApiInit = RequestInit & { timeoutMs?: number };

export async function callPartnerPublicApi(path: string, init?: CallApiInit): Promise<Response> {
  const base = API_BASE_URL.replace(/\/$/, "");
  const { timeoutMs = 25_000, ...requestInit } = init ?? {};
  const isFormDataBody = typeof FormData !== "undefined" && requestInit?.body instanceof FormData;
  const defaultHeaders: Record<string, string> = isFormDataBody ? {} : { "Content-Type": "application/json" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${base}${path}`, {
      ...requestInit,
      signal: controller.signal,
      headers: { ...defaultHeaders, ...(requestInit?.headers ?? {}) },
      cache: "no-store"
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callPartnerApi(path: string, init?: CallApiInit): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(PARTNER_SESSION_COOKIE)?.value ?? "";
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  return callPartnerPublicApi(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`
    }
  });
}

