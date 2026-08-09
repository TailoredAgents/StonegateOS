import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc } from "drizzle-orm";
import { auditLogs, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { buildAuditWhere, parseAuditQuery } from "@/lib/audit-query";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export const dynamic = "force-dynamic";

const MAX_EXPORT_EVENTS = 5_000;

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
  const permissionError = await requirePermission(request, "audit.export");
  if (permissionError) return permissionError;

  const parsed = parseAuditQuery(request.nextUrl.searchParams, {
    allowCursor: false,
    defaultLimit: MAX_EXPORT_EVENTS,
    maxLimit: MAX_EXPORT_EVENTS,
  });
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);

  const query = { ...parsed.query, cursor: null, limit: MAX_EXPORT_EVENTS };
  const filters = buildAuditWhere(query);
  const correlationId =
    request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const actor = getAuditActorFromRequest(request);
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
      idempotencyKeyHash: auditLogs.idempotencyKeyHash,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      meta: auditLogs.meta,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(MAX_EXPORT_EVENTS + 1);

  const filterEvidence = {
    entityType: query.entityType,
    entityId: query.entityId,
    actorId: query.actorId,
    actorType: query.actorType,
    action: query.action,
    outcome: query.outcome,
    correlationId: query.correlationId,
    from: query.from?.toISOString() ?? null,
    toExclusive: query.to?.toISOString() ?? null,
  };

  if (rows.length > MAX_EXPORT_EVENTS) {
    await recordAuditEvent({
      actor,
      action: "audit.export.failed",
      entityType: "audit_log",
      correlationId,
      requiredPermissions: ["audit.export"],
      outcome: "failed",
      surface: "audit",
      meta: {
        reason: "export_too_large",
        maximumEvents: MAX_EXPORT_EVENTS,
        filters: filterEvidence,
      },
    });
    return NextResponse.json(
      {
        error: "export_too_large",
        message: `This export contains more than ${MAX_EXPORT_EVENTS.toLocaleString("en-US")} events. Narrow the date or entity filters and try again.`,
        maximumEvents: MAX_EXPORT_EVENTS,
      },
      { status: 413 },
    );
  }

  const lines = rows.map((row) =>
    JSON.stringify({
      eventId: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      outcome: row.outcome,
      surface: row.surface,
      actor: {
        type: row.actorType,
        id: row.actorId,
        role: row.actorRole,
        label: row.actorLabel,
        sessionId: row.sessionId,
        authMethod: row.authMethod,
      },
      entity: { type: row.entityType, id: row.entityId },
      correlationId: row.correlationId,
      requiredPermissions: row.requiredPermissions ?? [],
      providerOperationId: row.providerOperationId,
      idempotencyKeyHash: row.idempotencyKeyHash,
      meta: sanitizeAuditMetadata(row.meta),
    }),
  );

  // The export is not released unless its own evidence is durably appended.
  await recordAuditEvent({
    actor,
    action: "audit.exported",
    entityType: "audit_log",
    correlationId,
    requiredPermissions: ["audit.export"],
    outcome: "succeeded",
    surface: "audit",
    meta: {
      format: "jsonl",
      eventCount: rows.length,
      filters: filterEvidence,
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  return new Response(lines.length > 0 ? `${lines.join("\n")}\n` : "", {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="stonegate-audit-${date}.jsonl"`,
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Audit-Correlation-Id": correlationId,
    },
  });
}
