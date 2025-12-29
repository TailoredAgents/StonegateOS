import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";
import { getDb, teamRoles } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const DEFAULT_ROLES = [
  {
    name: "Owner",
    slug: "owner",
    permissions: ["*"]
  },
  {
    name: "Office",
    slug: "office",
    permissions: [
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
    ]
  },
  {
    name: "Crew",
    slug: "crew",
    permissions: ["messages.read", "appointments.read", "appointments.update"]
  },
  {
    name: "Read-only",
    slug: "read_only",
    permissions: ["read"]
  }
];

async function ensureDefaultRoles(): Promise<void> {
  const db = getDb();
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(teamRoles);
  const total = Number(countResult[0]?.count ?? 0);
  if (total > 0) return;

  await db.insert(teamRoles).values(
    DEFAULT_ROLES.map((role) => ({
      name: role.name,
      slug: role.slug,
      permissions: role.permissions,
      createdAt: new Date(),
      updatedAt: new Date()
    }))
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  await ensureDefaultRoles();
  const db = getDb();
  const rows = await db
    .select({
      id: teamRoles.id,
      name: teamRoles.name,
      slug: teamRoles.slug,
      permissions: teamRoles.permissions,
      createdAt: teamRoles.createdAt,
      updatedAt: teamRoles.updatedAt
    })
    .from(teamRoles)
    .orderBy(asc(teamRoles.name));

  const roles = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    permissions: row.permissions ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }));

  return NextResponse.json({ roles });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    name?: string;
    slug?: string;
    permissions?: string[];
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const permissions = Array.isArray(payload.permissions)
    ? payload.permissions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }
  if (!slug) {
    return NextResponse.json({ error: "slug_required" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [role] = await db
    .insert(teamRoles)
    .values({
      name,
      slug,
      permissions,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .returning();

  if (!role) {
    return NextResponse.json({ error: "role_create_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "role.created",
    entityType: "team_role",
    entityId: role.id,
    meta: { slug }
  });

  return NextResponse.json({
    role: {
      id: role.id,
      name: role.name,
      slug: role.slug,
      permissions: role.permissions ?? []
    }
  });
}
