import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, isNotNull } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function normalizeDisposition(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function parseField(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "i"));
  const value = match?.[1]?.trim();
  return value && value.length ? value : null;
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
  const assignedToRaw = url.searchParams.get("memberId")?.trim() || "";
  const assignedTo = assignedToRaw.length ? assignedToRaw : config.defaultAssigneeMemberId;
  const limit = parseLimit(url.searchParams.get("limit"));

  const rows = await db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      status: crmTasks.status,
      notes: crmTasks.notes,
      createdAt: crmTasks.createdAt,
      updatedAt: crmTasks.updatedAt,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      contactSource: contacts.source
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.status, "open"),
        eq(crmTasks.assignedTo, assignedTo),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=outbound%"),
        isNotNull(crmTasks.contactId)
      )
    )
    .orderBy(asc(crmTasks.dueAt), desc(crmTasks.createdAt))
    .limit(limit);

  const now = new Date();
  const items = rows.map((row) => {
    const notes = typeof row.notes === "string" ? row.notes : "";
    const attempt = Number(parseField(notes, "attempt") ?? "1");
    const campaign = parseField(notes, "campaign");
    const lastDisposition = normalizeDisposition(parseField(notes, "lastDisposition"));
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
      attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
      campaign,
      lastDisposition,
      contact: {
        id: row.contactId,
        name,
        email: row.contactEmail ?? null,
        phone: row.contactPhoneE164 ?? row.contactPhone ?? null,
        source: row.contactSource ?? null
      }
    };
  });

  return NextResponse.json({ ok: true, memberId: assignedTo, items });
}
