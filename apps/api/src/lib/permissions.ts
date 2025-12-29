import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, teamMembers, teamRoles } from "@/db";
import { getAuditActorFromRequest } from "@/lib/audit";

type PermissionMatchMode = "any" | "all";

type PermissionContext = {
  enforce: boolean;
  role: string | null;
  permissions: string[];
};

const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ["*"],
  office: [
    "messages.send",
    "messages.read",
    "policy.read",
    "policy.write",
    "bookings.manage",
    "automation.read",
    "automation.write",
    "audit.read",
    "appointments.read",
    "appointments.update"
  ],
  crew: ["messages.read", "appointments.read", "appointments.update"],
  read_only: ["read"]
};

function normalizePermissions(permissions: string[] | null | undefined): string[] {
  if (!permissions) return [];
  return permissions
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (required === "read") return granted === "read";
  if (granted === "read") {
    return required === "read" || required.endsWith(".read");
  }
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -2);
    return required.startsWith(prefix);
  }
  return granted === required;
}

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) => permissionMatches(permission, required));
}

export async function resolvePermissionContext(request: NextRequest): Promise<PermissionContext> {
  const actor = getAuditActorFromRequest(request);
  const actorRole = actor.role ? actor.role.trim().toLowerCase() : null;
  const actorId = actor.id ? actor.id.trim() : null;

  if (!actorRole && !actorId) {
    return { enforce: false, role: null, permissions: ["*"] };
  }

  const db = getDb();

  if (actorId) {
    const [row] = await db
      .select({
        roleSlug: teamRoles.slug,
        permissions: teamRoles.permissions
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamMembers.id, actorId))
      .limit(1);

    if (row?.permissions) {
      return {
        enforce: true,
        role: row.roleSlug ?? actorRole,
        permissions: normalizePermissions(row.permissions)
      };
    }
  }

  if (actorRole) {
    const [roleRow] = await db
      .select({
        permissions: teamRoles.permissions
      })
      .from(teamRoles)
      .where(eq(teamRoles.slug, actorRole))
      .limit(1);

    if (roleRow?.permissions) {
      return {
        enforce: true,
        role: actorRole,
        permissions: normalizePermissions(roleRow.permissions)
      };
    }
  }

  const fallback = actorRole ? DEFAULT_ROLE_PERMISSIONS[actorRole] : null;
  return {
    enforce: true,
    role: actorRole,
    permissions: normalizePermissions(fallback)
  };
}

export async function requirePermission(
  request: NextRequest,
  required: string | string[],
  options?: { mode?: PermissionMatchMode }
): Promise<Response | null> {
  const context = await resolvePermissionContext(request);
  if (!context.enforce) return null;

  const requiredList = Array.isArray(required) ? required : [required];
  const mode = options?.mode ?? "any";
  const allowed =
    mode === "all"
      ? requiredList.every((permission) => hasPermission(context.permissions, permission))
      : requiredList.some((permission) => hasPermission(context.permissions, permission));

  if (allowed) return null;

  return NextResponse.json(
    {
      error: "forbidden",
      required: requiredList,
      role: context.role
    },
    { status: 403 }
  );
}
