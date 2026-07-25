import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { getDb, mobileOfflineMediaQueueHealth, teamMembers } from "@/db";
import { getAuditActorFromRequest } from "@/lib/audit";
import {
  MAX_OFFLINE_MEDIA_HEALTH_PAYLOAD_BYTES,
  parseMobileOfflineMediaQueueHealthReport,
  parseTeamMemberActorId,
} from "@/lib/mobile-offline-media-queue-health";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

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
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const actor = getAuditActorFromRequest(request);
  const teamMemberId = parseTeamMemberActorId(actor.id);
  if (!teamMemberId) {
    return NextResponse.json(
      { error: "authenticated_team_member_required" },
      { status: 401 },
    );
  }

  const db = getDb();
  const [teamMember] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.id, teamMemberId), eq(teamMembers.active, true)))
    .limit(1);
  if (!teamMember) {
    return NextResponse.json(
      { error: "authenticated_team_member_required" },
      { status: 401 },
    );
  }

  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const rawBody = await request.text();
  if (
    Buffer.byteLength(rawBody, "utf8") > MAX_OFFLINE_MEDIA_HEALTH_PAYLOAD_BYTES
  ) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json(
      { error: "invalid_payload", issues: [] },
      { status: 400 },
    );
  }
  const parsed = parseMobileOfflineMediaQueueHealthReport(payload);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_payload", issues: parsed.issues },
      { status: 400 },
    );
  }

  const receivedAt = new Date();
  const report = parsed.report;
  const returned = await db
    .insert(mobileOfflineMediaQueueHealth)
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
        mobileOfflineMediaQueueHealth.teamMemberId,
        mobileOfflineMediaQueueHealth.clientDeviceId,
      ],
      set: {
        queuedCount: report.queuedCount,
        failedCount: report.failedCount,
        oldestQueuedAt: report.oldestQueuedAt,
        clientReportedAt: report.reportedAt,
        lastReportedAt: receivedAt,
        updatedAt: receivedAt,
      },
      setWhere: lt(
        mobileOfflineMediaQueueHealth.clientReportedAt,
        report.reportedAt,
      ),
    })
    .returning({
      clientDeviceId: mobileOfflineMediaQueueHealth.clientDeviceId,
      queuedCount: mobileOfflineMediaQueueHealth.queuedCount,
      failedCount: mobileOfflineMediaQueueHealth.failedCount,
      oldestQueuedAt: mobileOfflineMediaQueueHealth.oldestQueuedAt,
      clientReportedAt: mobileOfflineMediaQueueHealth.clientReportedAt,
      lastReportedAt: mobileOfflineMediaQueueHealth.lastReportedAt,
    });

  const [current] =
    returned.length > 0
      ? returned
      : await db
          .select({
            clientDeviceId: mobileOfflineMediaQueueHealth.clientDeviceId,
            queuedCount: mobileOfflineMediaQueueHealth.queuedCount,
            failedCount: mobileOfflineMediaQueueHealth.failedCount,
            oldestQueuedAt: mobileOfflineMediaQueueHealth.oldestQueuedAt,
            clientReportedAt: mobileOfflineMediaQueueHealth.clientReportedAt,
            lastReportedAt: mobileOfflineMediaQueueHealth.lastReportedAt,
          })
          .from(mobileOfflineMediaQueueHealth)
          .where(
            and(
              eq(mobileOfflineMediaQueueHealth.teamMemberId, teamMemberId),
              eq(mobileOfflineMediaQueueHealth.clientDeviceId, report.deviceId),
            ),
          )
          .limit(1);
  if (!current) {
    throw new Error("offline_media_queue_health_upsert_failed");
  }

  return NextResponse.json({
    ok: true,
    accepted:
      current.clientReportedAt.getTime() === report.reportedAt.getTime() &&
      current.queuedCount === report.queuedCount &&
      current.failedCount === report.failedCount &&
      (current.oldestQueuedAt?.getTime() ?? null) ===
        (report.oldestQueuedAt?.getTime() ?? null),
    queueHealth: serializeQueueHealth(current),
  });
}
