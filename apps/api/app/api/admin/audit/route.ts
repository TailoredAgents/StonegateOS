import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, auditLogs, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "audit.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const entityType = searchParams.get("entityType");
  const entityId = searchParams.get("entityId");
  const actorId = searchParams.get("actorId");
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const filters = [];
  if (entityType) {
    filters.push(eq(auditLogs.entityType, entityType));
  }
  if (entityId) {
    filters.push(eq(auditLogs.entityId, entityId));
  }
  if (actorId) {
    filters.push(eq(auditLogs.actorId, actorId));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const db = getDb();
  const totalResult = whereClause
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(auditLogs)
        .where(whereClause)
    : await db.select({ count: sql<number>`count(*)` }).from(auditLogs);
  const total = Number(totalResult[0]?.count ?? 0);

  const rows = await (whereClause
    ? db
        .select({
          id: auditLogs.id,
          actorType: auditLogs.actorType,
          actorId: auditLogs.actorId,
          actorRole: auditLogs.actorRole,
          actorLabel: auditLogs.actorLabel,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          meta: auditLogs.meta,
          createdAt: auditLogs.createdAt,
          actorName: teamMembers.name
        })
        .from(auditLogs)
        .leftJoin(teamMembers, eq(auditLogs.actorId, teamMembers.id))
        .where(whereClause)
    : db
        .select({
          id: auditLogs.id,
          actorType: auditLogs.actorType,
          actorId: auditLogs.actorId,
          actorRole: auditLogs.actorRole,
          actorLabel: auditLogs.actorLabel,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          meta: auditLogs.meta,
          createdAt: auditLogs.createdAt,
          actorName: teamMembers.name
        })
        .from(auditLogs)
        .leftJoin(teamMembers, eq(auditLogs.actorId, teamMembers.id)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  const events = rows.map((row) => ({
    id: row.id,
    actor: {
      type: row.actorType,
      id: row.actorId,
      role: row.actorRole ?? null,
      label: row.actorLabel ?? null,
      name: row.actorName ?? null
    },
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString()
  }));

  const nextOffset = offset + events.length;

  return NextResponse.json({
    events,
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null
    }
  });
}
