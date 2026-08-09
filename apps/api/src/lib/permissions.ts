import crypto from "node:crypto";
import {
  TEAM_AUTHENTICATED_BASELINE_PERMISSIONS,
  TEAM_ASSIGNABLE_PERMISSION_CATALOG,
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  TEAM_PERMISSION_CATALOG,
  TEAM_ROLE_PERMISSION_TEMPLATES,
} from "@myst-os/sdk";
import type { TeamPermission } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, teamMembers, teamRoles, teamSessions } from "@/db";
import { setVerifiedRequestActor } from "@/lib/verified-actor-context";
import {
  getTeamOperationKillSwitch,
  type TeamOperationKillSwitch,
} from "@/lib/team-operation-kill-switch";
import { isAdminRequest } from "../../app/api/web/admin";

type PermissionMatchMode = "any" | "all";

export type PermissionContext = {
  authenticated: boolean;
  source: "team_session" | "break_glass" | "service" | null;
  role: string | null;
  permissions: string[];
  principalId: string | null;
  principalLabel: string | null;
  sessionId: string | null;
};

type MemberPermissionRow = {
  active: boolean | null;
  roleSlug: string | null;
  permissions: string[] | null;
  permissionsGrant: string[] | null;
  permissionsDeny: string[] | null;
};

export { TEAM_PERMISSION_CATALOG };
export type { TeamPermission };
export {
  getTeamOperationKillSwitch,
  getTeamOperationKillSwitchForRisk,
} from "@/lib/team-operation-kill-switch";
export type { TeamOperationKillSwitch } from "@/lib/team-operation-kill-switch";

// These are API-owned workers that currently call permission-gated admin
// routes. The internal API key authenticates the caller service; this map
// limits what each explicitly named non-human principal can do. Human callers
// never use this path.
const SERVICE_PERMISSIONS: Record<
  string,
  { actorType: "worker"; permissions: TeamPermission[] }
> = {
  "facebook-autopilot": {
    actorType: "worker",
    permissions: ["bookings.manage"],
  },
  "sales-draft-prep": {
    actorType: "worker",
    permissions: [
      "appointments.read",
      "appointments.update",
      "messages.write",
      "messages.send",
      "sales.read",
      "sales.write",
    ],
  },
  "outbox-dispatcher": {
    actorType: "worker",
    permissions: ["outbox.dispatch"],
  },
  "team-break-glass-exchange": {
    actorType: "worker",
    permissions: ["access.break_glass"],
  },
  "public-chat-booking": {
    actorType: "worker",
    permissions: [
      "contacts.write",
      "properties.write",
      "pipeline.write",
      "bookings.manage",
    ],
  },
};

const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ["*", ...TEAM_OWNER_ONLY_PERMISSION_CATALOG],
  office: [...TEAM_ROLE_PERMISSION_TEMPLATES.office.permissions],
  sales: [...TEAM_ROLE_PERMISSION_TEMPLATES.sales.permissions],
  crew: [...TEAM_ROLE_PERMISSION_TEMPLATES.crew.permissions],
  read_only: [...TEAM_ROLE_PERMISSION_TEMPLATES.read_only.permissions],
};

export function getDefaultPermissionsForRole(
  roleSlug: string | null | undefined,
): string[] {
  const normalized = roleSlug ? roleSlug.trim().toLowerCase() : "";
  return normalizePermissions(DEFAULT_ROLE_PERMISSIONS[normalized] ?? []);
}

function normalizePermissions(
  permissions: string[] | null | undefined,
): string[] {
  if (!permissions) return [];
  return permissions
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mergePermissions(base: string[], grant: string[]): string[] {
  const merged = [
    ...normalizePermissions(base),
    ...normalizePermissions(grant),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of merged) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function computeEffectivePermissions(input: {
  rolePermissions: string[] | null | undefined;
  grant: string[] | null | undefined;
  deny: string[] | null | undefined;
}): string[] {
  const merged = mergePermissions(input.rolePermissions ?? [], [
    ...(input.grant ?? []),
    ...TEAM_AUTHENTICATED_BASELINE_PERMISSIONS,
  ]);
  const denyList = normalizePermissions(input.deny);

  // Materialize wildcards into the human-assignable catalog. Explicitly
  // stored Owner-only permissions survive materialization, but a bare legacy
  // wildcard never acquires them. Granular denies still win in both cases.
  const explicitOwnerOnly = TEAM_OWNER_ONLY_PERMISSION_CATALOG.filter(
    (permission) => merged.includes(permission),
  );
  const granted = merged.includes("*")
    ? [
        ...TEAM_ASSIGNABLE_PERMISSION_CATALOG,
        ...explicitOwnerOnly,
        ...TEAM_AUTHENTICATED_BASELINE_PERMISSIONS,
      ]
    : merged;

  if (!denyList.length) return granted;

  return granted.filter(
    (permission) =>
      !denyList.some((denied) => permissionMatches(denied, permission)),
  );
}

export function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -2);
    return required.startsWith(prefix);
  }
  return granted === required;
}

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) =>
    permissionMatches(permission, required),
  );
}

function unauthenticatedContext(): PermissionContext {
  return {
    authenticated: false,
    source: null,
    role: null,
    permissions: [],
    principalId: null,
    principalLabel: null,
    sessionId: null,
  };
}

function rememberVerifiedPrincipal(
  request: NextRequest,
  context: PermissionContext,
): PermissionContext {
  if (!context.authenticated || !context.source) return context;

  setVerifiedRequestActor(request, {
    type: context.source === "service" ? "worker" : "human",
    id: context.principalId,
    role: context.role,
    label: context.principalLabel,
    sessionId: context.sessionId,
    authMethod: context.source,
  });
  return context;
}

function permissionsForMember(row: MemberPermissionRow): string[] {
  return computeEffectivePermissions({
    // Role slugs seed records during provisioning/migration; they never grant
    // authority at request time. The stored role and member overrides are the
    // single effective source of truth.
    rolePermissions: row.permissions ?? [],
    grant: row.permissionsGrant,
    deny: row.permissionsDeny,
  });
}

function readForwardedTeamSessionToken(request: NextRequest): string | null {
  // A team session is forwarded alongside, not instead of, the internal API
  // credential. This avoids interpreting legacy `Authorization: Bearer
  // <ADMIN_API_KEY>` service calls as human sessions during the migration.
  const hasExplicitInternalCredential = Boolean(
    request.headers.get("x-api-key") ?? request.headers.get("x-admin-api-key"),
  );
  if (!hasExplicitInternalCredential) return null;

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function resolveForwardedTeamSession(
  rawToken: string,
): Promise<PermissionContext> {
  const sessionHash = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("base64url");
  const db = getDb();
  const [row] = await db
    .select({
      sessionId: teamSessions.id,
      authMethod: teamSessions.authMethod,
      memberId: teamMembers.id,
      memberName: teamMembers.name,
      expiresAt: teamSessions.expiresAt,
      revokedAt: teamSessions.revokedAt,
      active: teamMembers.active,
      roleSlug: teamRoles.slug,
      permissions: teamRoles.permissions,
      permissionsGrant: teamMembers.permissionsGrant,
      permissionsDeny: teamMembers.permissionsDeny,
    })
    .from(teamSessions)
    .innerJoin(teamMembers, eq(teamSessions.teamMemberId, teamMembers.id))
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamSessions.sessionHash, sessionHash))
    .limit(1);

  if (
    !row?.sessionId ||
    (row.authMethod !== "team_session" && row.authMethod !== "break_glass") ||
    row.active !== true ||
    row.revokedAt !== null ||
    row.expiresAt <= new Date()
  ) {
    return unauthenticatedContext();
  }

  return {
    authenticated: true,
    source: row.authMethod,
    role: row.roleSlug?.trim().toLowerCase() ?? null,
    permissions: permissionsForMember(row),
    principalId: row.memberId,
    principalLabel: row.memberName,
    sessionId: row.sessionId,
  };
}

function resolveExplicitServiceContext(
  request: NextRequest,
): PermissionContext | null {
  const actorType = request.headers.get("x-actor-type")?.trim().toLowerCase();
  const label =
    request.headers.get("x-actor-label")?.trim().toLowerCase() ?? "";
  const service = label ? SERVICE_PERMISSIONS[label] : undefined;
  if (!service || actorType !== service.actorType) return null;

  return {
    authenticated: true,
    source: "service",
    role: null,
    permissions: [...service.permissions],
    principalId: request.headers.get("x-actor-id")?.trim() || null,
    principalLabel: label,
    sessionId: null,
  };
}

export async function resolvePermissionContext(
  request: NextRequest,
): Promise<PermissionContext> {
  // Admin routes require two independent trust checks: the private site/API
  // credential authenticates the calling service, while the verified session
  // or named service principal authorizes the individual operation. Merely
  // presenting either actor headers or an arbitrary x-api-key must fail closed.
  if (!isAdminRequest(request)) return unauthenticatedContext();

  const forwardedSessionToken = readForwardedTeamSessionToken(request);
  if (forwardedSessionToken) {
    // A presented human credential is authoritative. Invalid, expired, or
    // revoked sessions must not fall back to caller-supplied actor headers or
    // a service identity.
    const context = await resolveForwardedTeamSession(forwardedSessionToken);
    return rememberVerifiedPrincipal(request, context);
  }

  const serviceContext = resolveExplicitServiceContext(request);
  if (serviceContext) return rememberVerifiedPrincipal(request, serviceContext);
  return unauthenticatedContext();
}

export async function requirePermission(
  request: NextRequest,
  required: TeamPermission | TeamPermission[],
  options?: {
    mode?: PermissionMatchMode;
    ignoredKillSwitches?: readonly TeamOperationKillSwitch[];
  },
): Promise<Response | null> {
  const context = await resolvePermissionContext(request);
  if (!context.authenticated) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requiredList = Array.isArray(required) ? required : [required];
  const mode = options?.mode ?? "any";
  const allowed =
    mode === "all"
      ? requiredList.every((permission) =>
          hasPermission(context.permissions, permission),
        )
      : requiredList.some((permission) =>
          hasPermission(context.permissions, permission),
        );

  if (allowed) {
    const disabledCategory = options?.ignoredKillSwitches?.length
      ? getTeamOperationKillSwitch(requiredList, {
          ignoredCategories: options.ignoredKillSwitches,
        })
      : getTeamOperationKillSwitch(requiredList);
    if (disabledCategory) {
      return NextResponse.json(
        {
          error: "operation_disabled",
          category: disabledCategory,
          retryable: false,
        },
        { status: 503 },
      );
    }
    return null;
  }

  return NextResponse.json(
    {
      error: "forbidden",
      required: requiredList,
      role: context.role,
    },
    { status: 403 },
  );
}
