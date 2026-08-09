import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb, auditLogs, teamMembers } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  buildAuditWhere,
  encodeAuditCursor,
  parseAuditQuery,
} from "@/lib/audit-query";
import { AUDIT_RETENTION_POLICY } from "@/lib/audit-retention";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

function invalidFilter(field: string, message: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_filter", field, message },
    { status: 422 },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "audit.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const parsed = parseAuditQuery(searchParams);
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);
  const { query } = parsed;
  const filters = buildAuditWhere(query);

  const db = getDb();
  const rows = await db
    .select({
      id: auditLogs.id,
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      actorRole: auditLogs.actorRole,
      actorLabel: auditLogs.actorLabel,
      sessionId: auditLogs.sessionId,
      authMethod: auditLogs.authMethod,
      correlationId: auditLogs.correlationId,
      requiredPermissions: auditLogs.requiredPermissions,
      outcome: auditLogs.outcome,
      surface: auditLogs.surface,
      providerOperationId: auditLogs.providerOperationId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      meta: auditLogs.meta,
      createdAt: auditLogs.createdAt,
      actorName: teamMembers.name,
    })
    .from(auditLogs)
    .leftJoin(teamMembers, eq(auditLogs.actorId, teamMembers.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  const events = pageRows.map((row) => ({
    id: row.id,
    actor: {
      type: row.actorType,
      id: row.actorId,
      role: row.actorRole ?? null,
      label: row.actorLabel ?? null,
      name: row.actorName ?? null,
      sessionId: row.sessionId ?? null,
      authMethod: row.authMethod ?? null,
    },
    action: row.action,
    outcome: row.outcome ?? null,
    surface: row.surface ?? null,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    correlationId: row.correlationId ?? null,
    requiredPermissions: row.requiredPermissions ?? [],
    providerOperationId: row.providerOperationId ?? null,
    meta: sanitizeAuditMetadata(row.meta),
    createdAt: row.createdAt.toISOString(),
  }));

  return NextResponse.json({
    events,
    retention: AUDIT_RETENTION_POLICY,
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeAuditCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    },
  });
}
