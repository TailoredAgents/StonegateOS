import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm";
import { contacts, crmPipeline, crmTasks, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getSalesScorecardConfig, getSpeedToLeadDeadline } from "@/lib/sales-scorecard";

function parseLeadId(notes: string | null): string | null {
  if (!notes) return null;
  const match = notes.match(/leadId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function isSpeedTask(title: string): boolean {
  const t = title.toLowerCase();
  return t.includes("5 min sla") || t.includes("sla");
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);

  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId")?.trim() || config.defaultAssigneeMemberId;

  const now = new Date();
  const trackingStartAt =
    config.trackingStartAt && Number.isFinite(Date.parse(config.trackingStartAt)) ? new Date(config.trackingStartAt) : null;
  const effectiveSince = trackingStartAt && trackingStartAt.getTime() < now.getTime() ? trackingStartAt : null;
  const rows = await db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      status: crmTasks.status,
      notes: crmTasks.notes,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.assignedTo, memberId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.dueAt),
        isNotNull(crmTasks.notes),
        ...(effectiveSince ? [gte(crmTasks.createdAt, effectiveSince)] : []),
        or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%"))
      )
    )
    .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(100);

  const dedupedRows: typeof rows = [];
  const seenTaskKeys = new Set<string>();
  for (const row of rows) {
    const kind = isSpeedTask(row.title) ? "speed_to_lead" : "follow_up";
    const key = `${row.contactId}:${kind}`;
    if (seenTaskKeys.has(key)) continue;
    seenTaskKeys.add(key);
    dedupedRows.push(row);
  }

  const items: Array<{
    id: string;
    leadId: string | null;
    contact: { id: string; name: string; phone: string | null };
    title: string;
    dueAt: string | null;
    overdue: boolean;
    minutesUntilDue: number | null;
    kind: "speed_to_lead" | "follow_up";
  }> = [];
  for (const row of dedupedRows) {
    const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
    if (!hasPhone) continue;
    const dueAtIso = row.dueAt ? row.dueAt.toISOString() : null;
    const dueMs = row.dueAt ? row.dueAt.getTime() : null;
    const isOverdue = typeof dueMs === "number" ? dueMs < now.getTime() : false;
    const minutesUntilDue = typeof dueMs === "number" ? Math.round((dueMs - now.getTime()) / 60_000) : null;
    items.push({
      id: row.id,
      leadId: parseLeadId(row.notes ?? null),
      contact: {
        id: row.contactId,
        name: `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null
      },
      title: row.title,
      dueAt: dueAtIso,
      overdue: isOverdue,
      minutesUntilDue,
      kind: isSpeedTask(row.title) ? "speed_to_lead" : "follow_up"
    });
  }

  const seenContactIds = Array.from(new Set(rows.map((row) => row.contactId)));
  const defaultRecentSince = new Date(now.getTime() - 7 * 24 * 60_000 * 60);
  const recentSince =
    effectiveSince && effectiveSince.getTime() > defaultRecentSince.getTime() ? effectiveSince : defaultRecentSince;
  const missingFilters = [
    eq(contacts.salespersonMemberId, memberId),
    gte(contacts.createdAt, recentSince),
    lte(contacts.createdAt, now),
    or(isNull(crmPipeline.stage), notInArray(crmPipeline.stage, ["won", "lost"]))
  ];
  if (seenContactIds.length) {
    missingFilters.push(notInArray(contacts.id, seenContactIds.slice(0, 500)));
  }

  const missingRows = await db
    .select({
      id: contacts.id,
      createdAt: contacts.createdAt,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .where(
      and(...missingFilters)
    )
    .orderBy(desc(contacts.createdAt))
    .limit(25);

  for (const row of missingRows) {
    const deadline = getSpeedToLeadDeadline(row.createdAt, config);
    const dueMs = deadline.getTime();
    const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
    if (!hasPhone) continue;
    items.push({
      id: `contact:${row.id}`,
      leadId: null,
      contact: {
        id: row.id,
        name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null
      },
      title: hasPhone ? "Auto: Call new lead (5 min SLA)" : "Auto: Message new lead (5 min SLA)",
      dueAt: deadline.toISOString(),
      overdue: dueMs < now.getTime(),
      minutesUntilDue: Math.round((dueMs - now.getTime()) / 60_000),
      kind: "speed_to_lead"
    });
  }

  return NextResponse.json({ ok: true, memberId, now: now.toISOString(), items });
}
