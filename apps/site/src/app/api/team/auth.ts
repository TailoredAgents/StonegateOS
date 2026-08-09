import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { TeamPermission } from "@myst-os/sdk";
import {
  hasTeamPermission,
  resolveTeamPrincipalFromRequest,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { isSameOriginTeamRequest } from "@/lib/team-request-origin";

type PermissionMode = "any" | "all";

export type RequireTeamPrincipalOptions = {
  roles?: readonly string[];
  permissions?: TeamPermission | readonly TeamPermission[];
  permissionMode?: PermissionMode;
  redirectTo?: URL;
  returnJson?: boolean;
  flashError?: string;
};

export type TeamPrincipalResult =
  | {
      ok: true;
      principal: TeamRequestPrincipal;
      role: string | null;
    }
  | { ok: false; response: Response };

export async function resolveTeamRoleFromRequest(
  request: NextRequest,
): Promise<string | null> {
  const principal = await resolveTeamPrincipalFromRequest(request);
  return principal?.roleSlug ?? null;
}

function normalizeRequirements(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function deniedResponse(
  request: NextRequest,
  options: RequireTeamPrincipalOptions,
  status: 401 | 403,
): TeamPrincipalResult {
  const error = status === 401 ? "unauthorized" : "forbidden";
  const flashError =
    options.flashError ??
    (status === 401
      ? "Please sign in again and retry."
      : "You do not have permission to perform that action.");

  if (options.returnJson) {
    const response = NextResponse.json({ error }, { status });
    response.cookies.set({
      name: "myst-flash-error",
      value: flashError,
      path: "/",
    });
    return { ok: false, response };
  }

  const redirectTo = options.redirectTo ?? new URL("/team", request.url);
  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({
    name: "myst-flash-error",
    value: flashError,
    path: "/",
  });
  return { ok: false, response };
}

export async function requireTeamPrincipal(
  request: NextRequest,
  options: RequireTeamPrincipalOptions = {},
): Promise<TeamPrincipalResult> {
  if (!isSameOriginTeamRequest(request)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "forbidden",
          message: "The request origin could not be verified.",
        },
        {
          status: 403,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        },
      ),
    };
  }

  const principal = await resolveTeamPrincipalFromRequest(request);
  if (!principal) return deniedResponse(request, options, 401);

  const allowedRoles = normalizeRequirements(options.roles ?? []);
  if (
    allowedRoles.length > 0 &&
    (!principal.roleSlug || !allowedRoles.includes(principal.roleSlug))
  ) {
    return deniedResponse(request, options, 403);
  }

  const requiredPermissions = Array.isArray(options.permissions)
    ? normalizeRequirements(options.permissions)
    : typeof options.permissions === "string"
      ? normalizeRequirements([options.permissions])
      : [];
  if (requiredPermissions.length > 0) {
    const permissionMode = options.permissionMode ?? "any";
    const permitted =
      permissionMode === "all"
        ? requiredPermissions.every((permission) =>
            hasTeamPermission(principal, permission),
          )
        : requiredPermissions.some((permission) =>
            hasTeamPermission(principal, permission),
          );
    if (!permitted) return deniedResponse(request, options, 403);
  }

  return { ok: true, principal, role: principal.roleSlug };
}

export async function requireTeamRequestPrincipal(
  request: NextRequest,
  options: RequireTeamPrincipalOptions = {},
): Promise<TeamPrincipalResult> {
  return requireTeamPrincipal(request, options);
}

export async function requireTeamRole(
  request: NextRequest,
  options: RequireTeamPrincipalOptions = {},
): Promise<TeamPrincipalResult> {
  return requireTeamPrincipal(request, options);
}
