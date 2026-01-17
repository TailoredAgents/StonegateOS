import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, isNotNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { contacts, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { sql } from "drizzle-orm";

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

type DueFilter = "all" | "overdue" | "due_now" | "today" | "not_started";
type HasFilter = "any" | "phone" | "email" | "both";

function parseDue(value: string | null): DueFilter {
  const key = value?.trim().toLowerCase();
  if (key === "overdue" || key === "due_now" || key === "today" || key === "not_started") return key;
  return "all";
}

function parseHas(value: string | null): HasFilter {
  const key = value?.trim().toLowerCase();
  if (key === "phone" || key === "email" || key === "both") return key;
  return "any";
}

function parseAttempt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function includesQuery(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
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
  const offset = parseOffset(url.searchParams.get("offset"));

  const qRaw = url.searchParams.get("q");
  const q = typeof qRaw === "string" ? qRaw.trim() : "";
  const campaignFilter = url.searchParams.get("campaign")?.trim() || "";
  const dispositionFilter = normalizeDisposition(url.searchParams.get("disposition"));
  const dueFilter = parseDue(url.searchParams.get("due"));
  const hasFilter = parseHas(url.searchParams.get("has"));
  const attemptFilter = parseAttempt(url.searchParams.get("attempt"));

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
    .orderBy(sql`(${crmTasks.dueAt} is null) asc`, asc(crmTasks.dueAt), desc(crmTasks.createdAt))
    .limit(MAX_SCAN);

  const now = new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: config.timezone || "America/New_York" });
  const startOfTodayUtc = nowLocal.startOf("day").toUTC().toJSDate().getTime();
  const endOfTodayUtc = nowLocal.endOf("day").toUTC().toJSDate().getTime();

  const parsedItems = rows.map((row) => {
    const notes = typeof row.notes === "string" ? row.notes : "";
    const attempt = Number(parseField(notes, "attempt") ?? "1");
    const campaign = parseField(notes, "campaign");
    const lastDisposition = normalizeDisposition(parseField(notes, "lastDisposition"));
    const company = parseField(notes, "company");
    const noteSnippet = parseField(notes, "notes");
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
      company,
      noteSnippet,
      contact: {
        id: row.contactId,
        name,
        email: row.contactEmail ?? null,
        phone: row.contactPhoneE164 ?? row.contactPhone ?? null,
        source: row.contactSource ?? null
      }
    };
  });

  const filtered = parsedItems.filter((item) => {
    if (campaignFilter && item.campaign !== campaignFilter) return false;
    if (attemptFilter !== null && item.attempt !== attemptFilter) return false;
    if (dispositionFilter && item.lastDisposition !== dispositionFilter) return false;

    const hasPhone = Boolean(item.contact.phone);
    const hasEmail = Boolean(item.contact.email);
    if (hasFilter === "phone" && !hasPhone) return false;
    if (hasFilter === "email" && !hasEmail) return false;
    if (hasFilter === "both" && !(hasPhone && hasEmail)) return false;

    const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
    if (dueFilter === "overdue") {
      if (dueMs === null || dueMs >= now.getTime()) return false;
    } else if (dueFilter === "due_now") {
      if (dueMs === null || dueMs > now.getTime()) return false;
    } else if (dueFilter === "today") {
      if (dueMs === null || dueMs < startOfTodayUtc || dueMs > endOfTodayUtc) return false;
    } else if (dueFilter === "not_started") {
      if (dueMs !== null) return false;
    }

    if (q) {
      const search = q.toLowerCase();
      const haystack = [
        item.contact.name,
        item.contact.email ?? "",
        item.contact.phone ?? "",
        item.company ?? "",
        item.noteSnippet ?? ""
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : null;

  const summary = filtered.reduce(
    (acc, item) => {
      const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
      if (dueMs !== null && dueMs <= now.getTime()) acc.dueNow += 1;
      if (dueMs !== null && dueMs < now.getTime()) acc.overdue += 1;
      if (dueMs === null) acc.notStarted += 1;
      const isCallback = (item.title ?? "").toLowerCase().includes("callback") || item.lastDisposition === "callback_requested";
      if (isCallback && dueMs !== null && dueMs >= startOfTodayUtc && dueMs <= endOfTodayUtc) acc.callbacksToday += 1;
      return acc;
    },
    { dueNow: 0, overdue: 0, callbacksToday: 0, notStarted: 0 }
  );

  const facets = filtered.reduce(
    (acc, item) => {
      if (item.campaign) acc.campaigns.add(item.campaign);
      if (item.lastDisposition) acc.dispositions.add(item.lastDisposition);
      acc.attempts.add(String(item.attempt));
      return acc;
    },
    { campaigns: new Set<string>(), dispositions: new Set<string>(), attempts: new Set<string>() }
  );

  return NextResponse.json({
    ok: true,
    memberId: assignedTo,
    q: q || null,
    total,
    offset,
    limit,
    nextOffset,
    summary,
    facets: {
      campaigns: Array.from(facets.campaigns).sort(),
      dispositions: Array.from(facets.dispositions).sort(),
      attempts: Array.from(facets.attempts).sort((a, b) => Number(a) - Number(b))
    },
    items: page
  });
}
