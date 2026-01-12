import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

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
        ilike(crmTasks.notes, "%[auto] leadId=%")
      )
    )
    .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(100);

  const items = rows.map((row) => {
    const dueAtIso = row.dueAt ? row.dueAt.toISOString() : null;
    const dueMs = row.dueAt ? row.dueAt.getTime() : null;
    const isOverdue = typeof dueMs === "number" ? dueMs < now.getTime() : false;
    const minutesUntilDue = typeof dueMs === "number" ? Math.round((dueMs - now.getTime()) / 60_000) : null;
    return {
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
    };
  });

  return NextResponse.json({ ok: true, memberId, now: now.toISOString(), items });
}

