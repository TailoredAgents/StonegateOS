import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { getDb, mobileExpenseQueueHealth } from "@/db";
import { getAuditActorFromRequest } from "@/lib/audit";
import {
  MAX_OFFLINE_MEDIA_HEALTH_PAYLOAD_BYTES,
  parseMobileOfflineMediaQueueHealthReport,
  parseTeamMemberActorId,
} from "@/lib/mobile-offline-media-queue-health";
import { requirePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function serializeQueueHealth(row: {
  clientDeviceId: string;
  queuedCount: number;
  failedCount: number;
  oldestQueuedAt: Date | null;
  clientReportedAt: Date;
  lastReportedAt: Date;
}) {
  return {
    deviceId: row.clientDeviceId,
    queuedCount: row.queuedCount,
    failedCount: row.failedCount,
    oldestQueuedAt: row.oldestQueuedAt?.toISOString() ?? null,
    reportedAt: row.clientReportedAt.toISOString(),
    receivedAt: row.lastReportedAt.toISOString(),
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "expenses.submit");
  if (permissionError) return permissionError;

  const actor = getAuditActorFromRequest(request);
  const teamMemberId = parseTeamMemberActorId(actor.id);
  if (!teamMemberId) {
    return NextResponse.json(
      { error: "authenticated_team_member_required" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const rawBody = await request.text();
  if (
    Buffer.byteLength(rawBody, "utf8") > MAX_OFFLINE_MEDIA_HEALTH_PAYLOAD_BYTES
  ) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { status: 413, headers: NO_STORE_HEADERS },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json(
      { error: "invalid_payload", issues: [] },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = parseMobileOfflineMediaQueueHealthReport(payload);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_payload", issues: parsed.issues },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const receivedAt = new Date();
  const report = parsed.report;
  const db = getDb();
  const returned = await db
    .insert(mobileExpenseQueueHealth)
    .values({
      teamMemberId,
      clientDeviceId: report.deviceId,
      queuedCount: report.queuedCount,
      failedCount: report.failedCount,
      oldestQueuedAt: report.oldestQueuedAt,
      clientReportedAt: report.reportedAt,
      lastReportedAt: receivedAt,
      updatedAt: receivedAt,
    })
    .onConflictDoUpdate({
      target: [
        mobileExpenseQueueHealth.teamMemberId,
        mobileExpenseQueueHealth.clientDeviceId,
      ],
      set: {
        queuedCount: report.queuedCount,
        failedCount: report.failedCount,
        oldestQueuedAt: report.oldestQueuedAt,
        clientReportedAt: report.reportedAt,
        lastReportedAt: receivedAt,
        updatedAt: receivedAt,
      },
      setWhere: lt(mobileExpenseQueueHealth.clientReportedAt, report.reportedAt),
    })
    .returning({
      clientDeviceId: mobileExpenseQueueHealth.clientDeviceId,
      queuedCount: mobileExpenseQueueHealth.queuedCount,
      failedCount: mobileExpenseQueueHealth.failedCount,
      oldestQueuedAt: mobileExpenseQueueHealth.oldestQueuedAt,
      clientReportedAt: mobileExpenseQueueHealth.clientReportedAt,
      lastReportedAt: mobileExpenseQueueHealth.lastReportedAt,
    });

  const [current] =
    returned.length > 0
      ? returned
      : await db
          .select({
            clientDeviceId: mobileExpenseQueueHealth.clientDeviceId,
            queuedCount: mobileExpenseQueueHealth.queuedCount,
            failedCount: mobileExpenseQueueHealth.failedCount,
            oldestQueuedAt: mobileExpenseQueueHealth.oldestQueuedAt,
            clientReportedAt: mobileExpenseQueueHealth.clientReportedAt,
            lastReportedAt: mobileExpenseQueueHealth.lastReportedAt,
          })
          .from(mobileExpenseQueueHealth)
          .where(
            and(
              eq(mobileExpenseQueueHealth.teamMemberId, teamMemberId),
              eq(mobileExpenseQueueHealth.clientDeviceId, report.deviceId),
            ),
          )
          .limit(1);
  if (!current) throw new Error("expense_queue_health_upsert_failed");

  return NextResponse.json(
    {
      ok: true,
      accepted:
        current.clientReportedAt.getTime() === report.reportedAt.getTime() &&
        current.queuedCount === report.queuedCount &&
        current.failedCount === report.failedCount &&
        (current.oldestQueuedAt?.getTime() ?? null) ===
          (report.oldestQueuedAt?.getTime() ?? null),
      queueHealth: serializeQueueHealth(current),
    },
    { headers: NO_STORE_HEADERS },
  );
}
