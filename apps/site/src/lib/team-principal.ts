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
  if (!payload?.ok || !payload.teamMember) return null;

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

export const verifyTeamSessionToken = cache(
  async (sessionToken: string): Promise<TeamRequestPrincipal | null> => {
    const token = sessionToken.trim();
    if (!token) return null;

    try {
      const response = await fetch(
        `${resolveApiBase()}/api/public/team/session`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
      if (!response.ok) return null;

      const payload = (await response
        .json()
        .catch(() => null)) as TeamSessionApiResponse | null;
      return parseVerifiedPrincipal(token, payload);
    } catch {
      return null;
    }
  },
);

export async function resolveTeamPrincipalFromRequest(
  request: NextRequest,
): Promise<TeamRequestPrincipal | null> {
  const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? "";
  return verifyTeamSessionToken(token);
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

export class TeamPrincipalRequiredError extends Error {
  readonly status = 401;
  readonly code = "unauthorized";

  constructor() {
    super("A verified team session is required");
    this.name = "TeamPrincipalRequiredError";
  }
}

export async function requireCurrentTeamPrincipal(): Promise<TeamRequestPrincipal> {
  const principal = await resolveTeamPrincipalFromCookies();
  if (!principal) throw new TeamPrincipalRequiredError();
  return principal;
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
