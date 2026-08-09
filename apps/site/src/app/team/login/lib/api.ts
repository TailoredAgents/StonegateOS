import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";

type CallApiInit = RequestInit & { timeoutMs?: number };

export type LegacyRecoveryType = "owner" | "crew" | "invalid";

export async function callTeamPublicApi(
  path: string,
  init?: CallApiInit,
): Promise<Response> {
  const base = API_BASE_URL.replace(/\/$/, "");
  const { timeoutMs = 25_000, ...requestInit } = init ?? {};
  const isFormDataBody =
    typeof FormData !== "undefined" && requestInit?.body instanceof FormData;
  const defaultHeaders: Record<string, string> = isFormDataBody
    ? {}
    : { "Content-Type": "application/json" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${base}${path}`, {
      ...requestInit,
      signal: controller.signal,
      headers: { ...defaultHeaders, ...(requestInit?.headers ?? {}) },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callTeamApi(
  path: string,
  init?: CallApiInit,
): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return callTeamPublicApi(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function callTeamBreakGlassExchange(input: {
  legacyType: LegacyRecoveryType;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<Response> {
  const internalKey = process.env["ADMIN_API_KEY"]?.trim() ?? "";
  if (!internalKey) {
    throw new Error("Team recovery service is not configured");
  }

  const base = API_BASE_URL.replace(/\/$/, "");
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-api-key": internalKey,
    "x-actor-type": "worker",
    "x-actor-label": "team-break-glass-exchange",
    "x-correlation-id": randomUUID(),
  });
  if (input.clientIp) headers.set("x-forwarded-for", input.clientIp);
  if (input.userAgent) {
    headers.set("x-team-client-user-agent", input.userAgent);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${base}/api/admin/team/break-glass/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ legacyType: input.legacyType }),
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
