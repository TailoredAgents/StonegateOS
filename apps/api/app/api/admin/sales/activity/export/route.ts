import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { auditLogs, getDb, teamMembers } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { csvCell } from "@/lib/expense-export";
import { requirePermission } from "@/lib/permissions";
import { publicSalesActivityContext } from "@/lib/sales-activity-public";
import { parseSalesActivityQuery } from "@/lib/sales-activity-query";
import { isAdminRequest } from "../../../../web/admin";

export const dynamic = "force-dynamic";

export const MAX_SALES_ACTIVITY_EXPORT_EVENTS = 5_000;

function csvRow(
  values: readonly (string | number | null | undefined)[],
): string {
  return values.map(csvCell).join(",");
}

function invalidFilter(field: string, message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: "invalid_filter", field, message },
    { status: 422, headers: { "Cache-Control": "no-store" } },
  );
}

function correlationIdFor(request: NextRequest): string {
  const requested = request.headers.get("x-request-id")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(requested)
    ? requested
    : crypto.randomUUID();
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    ["sales.read", "audit.export"],
    { mode: "all" },
  );
  if (permissionError) return permissionError;

  if (request.nextUrl.searchParams.has("limit")) {
    return invalidFilter(
      "limit",
      "Sales Activity exports use a fixed safe limit.",
    );
  }
  if (request.nextUrl.searchParams.has("offset")) {
    return invalidFilter(
      "offset",
      "Sales Activity exports include the complete filtered window and do not accept a page offset.",
    );
  }
  if (request.nextUrl.searchParams.has("cursor")) {
    return invalidFilter(
      "cursor",
      "Sales Activity exports use the complete filtered window, not a screen-page cursor.",
    );
  }

  const parsed = parseSalesActivityQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);

  const { rangeDays, actorId, actions } = parsed.query;
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1_000);
  const filters = [
    gte(auditLogs.createdAt, since),
    inArray(auditLogs.action, actions),
    sql`${auditLogs.action} <> 'call.started' OR ${auditLogs.outcome} = 'succeeded'`,
  ];
  if (actorId) filters.push(eq(auditLogs.actorId, actorId));

  const correlationId = correlationIdFor(request);
  const actor = getAuditActorFromRequest(request);
  const filterEvidence = {
    rangeDays,
    since: since.toISOString(),
    memberId: actorId,
    actions,
  };

  try {
    const rows = await getDb()
      .select({
        id: auditLogs.id,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        actorRole: auditLogs.actorRole,
        actorName: teamMembers.name,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        outcome: auditLogs.outcome,
        meta: auditLogs.meta,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(teamMembers, eq(auditLogs.actorId, teamMembers.id))
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(MAX_SALES_ACTIVITY_EXPORT_EVENTS + 1);

    if (rows.length > MAX_SALES_ACTIVITY_EXPORT_EVENTS) {
      await recordAuditEvent({
        actor,
        action: "sales.activity.export.failed",
        entityType: "audit_log",
        correlationId,
        requiredPermissions: ["sales.read", "audit.export"],
        outcome: "failed",
        surface: "sales-hq",
        meta: {
          reason: "export_too_large",
          maximumEvents: MAX_SALES_ACTIVITY_EXPORT_EVENTS,
          filters: filterEvidence,
        },
      });
      return NextResponse.json(
        {
          ok: false,
          error: "export_too_large",
          message: `This export contains more than ${MAX_SALES_ACTIVITY_EXPORT_EVENTS.toLocaleString("en-US")} events. Narrow the member, event, or time filters and try again.`,
          maximumEvents: MAX_SALES_ACTIVITY_EXPORT_EVENTS,
          truncated: false,
        },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }

    const header = csvRow([
      "Event ID",
      "Occurred at",
      "Action",
      "Outcome",
      "Actor type",
      "Actor name",
      "Actor role",
      "Channel",
      "Action type",
      "Terminal outcome",
      "Contact ID",
      "Lead ID",
      "Thread ID",
      "Call record ID",
      "Task ID",
    ]);
    const bodyRows = rows.map((row) => {
      const context = publicSalesActivityContext({
        entityType: row.entityType,
        entityId: row.entityId,
        meta: row.meta,
      });
      return csvRow([
        row.id,
        row.createdAt.toISOString(),
        row.action,
        row.outcome,
        row.actorType,
        row.actorName ?? row.actorType,
        row.actorRole,
        context.channel,
        context.actionType,
        context.terminalOutcome,
        context.contactId,
        context.leadId,
        context.threadId,
        context.callRecordId,
        context.taskId,
      ]);
    });

    // Do not release operational records unless the export itself has durable
    // actor, permission, filter, and row-count evidence. Raw audit metadata,
    // customer names, message bodies, addresses, and provider identifiers are
    // intentionally excluded from the file.
    await recordAuditEvent({
      actor,
      action: "sales.activity.exported",
      entityType: "audit_log",
      correlationId,
      requiredPermissions: ["sales.read", "audit.export"],
      outcome: "succeeded",
      surface: "sales-hq",
      meta: {
        format: "csv",
        eventCount: rows.length,
        maximumEvents: MAX_SALES_ACTIVITY_EXPORT_EVENTS,
        truncated: false,
        filters: filterEvidence,
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    return new Response(`${[header, ...bodyRows].join("\r\n")}\r\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="stonegate-sales-activity-${date}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Export-Row-Count": String(rows.length),
        "X-Export-Maximum-Rows": String(MAX_SALES_ACTIVITY_EXPORT_EVENTS),
        "X-Export-Truncated": "false",
        "X-Audit-Correlation-Id": correlationId,
      },
    });
  } catch (error) {
    console.error("[sales.activity] export_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      await recordAuditEvent({
        actor,
        action: "sales.activity.export.failed",
        entityType: "audit_log",
        correlationId,
        requiredPermissions: ["sales.read", "audit.export"],
        outcome: "failed",
        surface: "sales-hq",
        meta: { reason: "export_unavailable", filters: filterEvidence },
      });
    } catch {
      // The file is still withheld. Observability records only the safe
      // correlation identifier above; no export contents are logged.
    }
    return NextResponse.json(
      {
        ok: false,
        error: "sales_activity_export_failed",
        message:
          "The Sales Activity export could not be prepared or audited. No file was released.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
