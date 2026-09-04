import { cache } from "react";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import type { TeamPrincipal } from "@myst-os/sdk";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { hasTeamPermissionValue } from "@/lib/team-permissions";

export { teamPermissionMatches } from "@/lib/team-permissions";
export type { TeamPrincipal } from "@myst-os/sdk";

type TeamSessionApiResponse = {
  ok?: boolean;
  sessionId?: unknown;
  authMethod?: unknown;
  teamMember?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
    roleSlug?: unknown;
    passwordSet?: unknown;
    permissions?: unknown;
  };
};

export type TeamSessionVerificationResult =
  | { kind: "valid"; principal: TeamRequestPrincipal }
  | { kind: "invalid" }
  | {
      kind: "unavailable";
      reason:
        | "timeout"
        | "network_error"
        | "rate_limited"
        | "upstream_error"
        | "malformed_response";
      retryAfter: string | null;
    };

export const TEAM_SESSION_VERIFICATION_TIMEOUT_MS = 2_000;

export type TeamRequestPrincipal = TeamPrincipal & {
  sessionToken: string;
  name: string;
  email: string | null;
  passwordSet: boolean;
};

export type TeamMemberIdentity = {
  id: string;
  name: string;
  email: string | null;
  roleSlug: string | null;
  passwordSet: boolean;
  permissions: string[];
};

function resolveApiBase(): string {
  return (
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
}

function normalizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseVerifiedPrincipal(
  sessionToken: string,
  payload: TeamSessionApiResponse | null,
): TeamRequestPrincipal | null {
  if (payload?.ok !== true || !payload.teamMember) return null;

  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const authMethod =
    payload.authMethod === "team_session" ||
    payload.authMethod === "break_glass"
      ? payload.authMethod
      : null;

  const memberId =
    typeof payload.teamMember.id === "string"
      ? payload.teamMember.id.trim()
      : "";
  const name =
    typeof payload.teamMember.name === "string"
      ? payload.teamMember.name.trim()
      : "";
  if (!sessionId || !authMethod || !memberId || !name) return null;
  const roleSlug =
    typeof payload.teamMember.roleSlug === "string" &&
    payload.teamMember.roleSlug.trim()
      ? payload.teamMember.roleSlug.trim().toLowerCase()
      : null;
  const email =
    typeof payload.teamMember.email === "string"
      ? payload.teamMember.email
      : null;

  return {
    sessionToken,
    memberId,
    sessionId,
    name,
    label: name,
    email,
    roleSlug,
    authMethod,
    passwordSet: payload.teamMember.passwordSet === true,
    permissions: normalizePermissions(payload.teamMember.permissions),
  };
}

function normalizeRetryAfter(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!/^\d{1,5}$/u.test(normalized)) return null;
  const seconds = Number(normalized);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400
    ? String(seconds)
    : null;
}

export async function verifyTeamSessionTokenResult(
  sessionToken: string,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    apiBaseUrl?: string;
  } = {},
): Promise<TeamSessionVerificationResult> {
  const token = sessionToken.trim();
  if (!token) return { kind: "invalid" };

  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? TEAM_SESSION_VERIFICATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const apiBaseUrl = (options.apiBaseUrl ?? resolveApiBase()).replace(
      /\/$/u,
      "",
    );
    const response = await fetcher(`${apiBaseUrl}/api/public/team/session`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: "invalid" };
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        reason: response.status === 429 ? "rate_limited" : "upstream_error",
        retryAfter:
          response.status === 429
            ? normalizeRetryAfter(response.headers.get("retry-after"))
            : null,
      };
    }

    const payload = (await response
      .json()
      .catch(() => null)) as TeamSessionApiResponse | null;
    const principal = parseVerifiedPrincipal(token, payload);
    return principal
      ? { kind: "valid", principal }
      : {
          kind: "unavailable",
          reason: "malformed_response",
          retryAfter: null,
        };
  } catch {
    return {
      kind: "unavailable",
      reason: timedOut ? "timeout" : "network_error",
      retryAfter: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const cachedTeamSessionVerification = cache(
  async (sessionToken: string): Promise<TeamSessionVerificationResult> =>
    verifyTeamSessionTokenResult(sessionToken),
);

/** Compatibility helper for read-only callers that accept a nullable result. */
export const verifyTeamSessionToken = cache(
  async (sessionToken: string): Promise<TeamRequestPrincipal | null> => {
    const verification = await cachedTeamSessionVerification(sessionToken);
    return verification.kind === "valid" ? verification.principal : null;
  },
);

export async function resolveTeamPrincipalFromRequest(
  request: NextRequest,
): Promise<TeamSessionVerificationResult> {
  const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? "";
  return cachedTeamSessionVerification(token);
}

export async function resolveTeamPrincipalFromCookies(): Promise<TeamRequestPrincipal | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(TEAM_SESSION_COOKIE)?.value ?? "";
    return await verifyTeamSessionToken(token);
  } catch {
    return null;
  }
}

export async function resolveTeamPrincipalResultFromCookies(): Promise<TeamSessionVerificationResult> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(TEAM_SESSION_COOKIE)?.value ?? "";
    return await cachedTeamSessionVerification(token);
  } catch {
    return {
      kind: "unavailable",
      reason: "network_error",
      retryAfter: null,
    };
  }
}

export class TeamPrincipalRequiredError extends Error {
  readonly status = 401;
  readonly code = "unauthorized";

  constructor() {
    super("A verified team session is required");
    this.name = "TeamPrincipalRequiredError";
  }
}

export class TeamSessionVerificationUnavailableError extends Error {
  readonly status = 503;
  readonly code = "session_verification_unavailable";
  readonly retryAfter: string | null;

  constructor(
    result: Extract<TeamSessionVerificationResult, { kind: "unavailable" }>,
  ) {
    super(
      "Your session could not be verified because the service is temporarily unavailable. Keep your work and try again.",
    );
    this.name = "TeamSessionVerificationUnavailableError";
    this.retryAfter = result.retryAfter;
  }
}

export function requireVerifiedTeamPrincipal(
  verification: TeamSessionVerificationResult,
): TeamRequestPrincipal {
  if (verification.kind === "valid") return verification.principal;
  if (verification.kind === "unavailable") {
    throw new TeamSessionVerificationUnavailableError(verification);
  }
  throw new TeamPrincipalRequiredError();
}

export async function requireCurrentTeamPrincipal(): Promise<TeamRequestPrincipal> {
  const verification = await resolveTeamPrincipalResultFromCookies();
  return requireVerifiedTeamPrincipal(verification);
}

export function toTeamMemberIdentity(
  principal: TeamRequestPrincipal,
): TeamMemberIdentity {
  return {
    id: principal.memberId,
    name: principal.name,
    email: principal.email,
    roleSlug: principal.roleSlug,
    passwordSet: principal.passwordSet,
    permissions: [...principal.permissions],
  };
}

export function hasTeamPermission(
  principal: Pick<TeamRequestPrincipal, "permissions">,
  required: string,
): boolean {
  return hasTeamPermissionValue(principal.permissions, required);
}
