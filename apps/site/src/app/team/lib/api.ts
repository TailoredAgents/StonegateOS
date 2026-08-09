import {
  requireCurrentTeamPrincipal,
  resolveTeamPrincipalFromCookies,
  toTeamMemberIdentity,
  type TeamMemberIdentity,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { TEAM_TIME_ZONE } from "./timezone";

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "http://localhost:3001";
const ADMIN_API_KEY = process.env["ADMIN_API_KEY"];

type CallAdminApiInit = RequestInit & { timeoutMs?: number };

export async function resolveTeamMemberFromSessionCookie(): Promise<TeamMemberIdentity | null> {
  const principal = await resolveTeamPrincipalFromCookies();
  return principal ? toTeamMemberIdentity(principal) : null;
}

export async function callAdminApiAs(
  principal: TeamRequestPrincipal,
  path: string,
  init?: CallAdminApiInit,
): Promise<Response> {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set");
  }

  const base = API_BASE_URL.replace(/\/$/, "");
  const { timeoutMs = 25_000, ...requestInit } = init ?? {};
  const isFormDataBody =
    typeof FormData !== "undefined" && requestInit?.body instanceof FormData;
  const headers = new Headers(requestInit.headers);
  if (!isFormDataBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Authorization", `Bearer ${principal.sessionToken}`);
  headers.set("x-api-key", ADMIN_API_KEY);
  headers.set("x-actor-type", "human");
  headers.set("x-actor-id", principal.memberId);
  headers.set("x-actor-label", principal.name);
  const method = (requestInit.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    // The browser mutation terminates at the authenticated Site boundary.
    // The trusted Site-to-API hop asserts the API origin; callers cannot
    // override it through RequestInit headers.
    headers.set("Origin", new URL(base).origin);
  }
  if (principal.roleSlug) {
    headers.set("x-actor-role", principal.roleSlug);
  } else {
    headers.delete("x-actor-role");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${base}${path}`, {
      ...requestInit,
      signal: controller.signal,
      headers,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Compatibility bridge for server-only callers that have not yet been
 * migrated to accept a verified principal explicitly. New `/team` code must
 * use `callAdminApiAs` so the caller's authorization boundary is visible.
 */
export async function callAdminApiForCurrentSession(
  path: string,
  init?: CallAdminApiInit,
): Promise<Response> {
  const principal = await requireCurrentTeamPrincipal();
  return callAdminApiAs(principal, path, init);
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function fmtMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
