import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { contacts, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_SCAN = 500;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const config = await getSalesScorecardConfig(db);

  const url = new URL(request.url);
  const assignedToRaw = url.searchParams.get("memberId")?.trim() || "";
  const assignedTo = assignedToRaw.length ? assignedToRaw : config.defaultAssigneeMemberId;
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));

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
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.status, "open"),
        eq(crmTasks.assignedTo, assignedTo),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=canvass%")
      )
    )
    .orderBy(sql`(${crmTasks.dueAt} is null) asc`, asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(MAX_SCAN);

  const now = new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: config.timezone || "America/New_York" });
  const startOfTodayUtc = nowLocal.startOf("day").toUTC().toJSDate().getTime();
  const endOfTodayUtc = nowLocal.endOf("day").toUTC().toJSDate().getTime();

  const items = rows.map((row) => {
    const dueAtIso = row.dueAt instanceof Date ? row.dueAt.toISOString() : null;
    const dueMs = row.dueAt instanceof Date ? row.dueAt.getTime() : null;
    const overdue = dueMs !== null ? dueMs < now.getTime() : false;
    const minutesUntilDue = dueMs !== null ? Math.round((dueMs - now.getTime()) / 60_000) : null;
    const name = `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim() || "Contact";

    return {
      id: row.id,
      title: row.title,
      dueAt: dueAtIso,
      overdue,
      minutesUntilDue,
      contact: {
        id: row.contactId,
        name,
        phone: row.contactPhoneE164 ?? row.contactPhone ?? null,
        email: row.contactEmail ?? null
      }
    };
  });

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : null;

  const summary = page.reduce(
    (acc, item) => {
      const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
      if (dueMs !== null && dueMs <= now.getTime()) acc.dueNow += 1;
      if (dueMs !== null && dueMs < now.getTime()) acc.overdue += 1;
      if (dueMs === null) acc.notStarted += 1;
      if (dueMs !== null && dueMs >= startOfTodayUtc && dueMs <= endOfTodayUtc) acc.dueToday += 1;
      return acc;
    },
    { dueNow: 0, overdue: 0, notStarted: 0, dueToday: 0 }
  );

  return NextResponse.json({
    ok: true,
    memberId: assignedTo,
    total,
    offset,
    limit,
    nextOffset,
    summary,
    items: page
  });
}
