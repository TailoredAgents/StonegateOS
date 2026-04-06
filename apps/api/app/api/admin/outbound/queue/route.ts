import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { contacts, crmTasks, getDb, outboxEvents, partnerAccounts } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { ensureOutboundAccountBrief } from "@/lib/outbound-account-briefs";

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

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
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
  const selectedAccountId = url.searchParams.get("accountId")?.trim() || "";
  const selectedTaskId = url.searchParams.get("taskId")?.trim() || "";
  const campaignFilter = url.searchParams.get("campaign")?.trim() || "";
  const dispositionFilter = normalizeDisposition(url.searchParams.get("disposition"));
  const dueFilter = parseDue(url.searchParams.get("due"));
  const hasFilter = parseHas(url.searchParams.get("has"));
  const attemptFilter = parseAttempt(url.searchParams.get("attempt"));

  const now = new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: config.timezone || "America/New_York" });
  const startOfTodayUtcDate = nowLocal.startOf("day").toUTC().toJSDate();
  const endOfTodayUtcDate = nowLocal.endOf("day").toUTC().toJSDate();
  const startOfTodayUtcMs = startOfTodayUtcDate.getTime();
  const endOfTodayUtcMs = endOfTodayUtcDate.getTime();

  const dueFilters: Array<ReturnType<typeof sql>> = [];
  if (dueFilter === "not_started") {
    dueFilters.push(isNull(crmTasks.dueAt));
  } else if (dueFilter === "overdue") {
    dueFilters.push(isNotNull(crmTasks.dueAt), lt(crmTasks.dueAt, now));
  } else if (dueFilter === "due_now") {
    dueFilters.push(isNotNull(crmTasks.dueAt), lte(crmTasks.dueAt, now));
  } else if (dueFilter === "today") {
    dueFilters.push(isNotNull(crmTasks.dueAt), gte(crmTasks.dueAt, startOfTodayUtcDate), lte(crmTasks.dueAt, endOfTodayUtcDate));
  }

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
      contactSource: contacts.source,
      accountId: partnerAccounts.id,
      accountName: partnerAccounts.name,
      accountStatus: partnerAccounts.status,
      accountSegment: partnerAccounts.segment,
      accountPortalFit: partnerAccounts.portalFit,
      accountFitScore: partnerAccounts.fitScore,
      accountLastTouchAt: partnerAccounts.lastTouchAt,
      accountNextTouchAt: partnerAccounts.nextTouchAt
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .leftJoin(partnerAccounts, eq(crmTasks.partnerAccountId, partnerAccounts.id))
    .where(
      and(
        eq(crmTasks.status, "open"),
        eq(crmTasks.assignedTo, assignedTo),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=outbound%"),
        isNotNull(crmTasks.contactId),
        ...dueFilters
      )
    )
    .orderBy(sql`(${crmTasks.dueAt} is null) asc`, asc(crmTasks.dueAt), desc(crmTasks.createdAt))
    .limit(MAX_SCAN);

  const parsedItems = rows.map((row) => {
    const notes = typeof row.notes === "string" ? row.notes : "";
    const attempt = Number(parseField(notes, "attempt") ?? "1");
    const campaign = parseField(notes, "campaign");
    const lastDisposition = normalizeDisposition(parseField(notes, "lastDisposition"));
    const company = parseField(notes, "company");
    const noteSnippet = parseField(notes, "notes");
    const startedAt = parseField(notes, "startedAt");
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
      startedAt: startedAt && !Number.isNaN(Date.parse(startedAt)) ? new Date(startedAt).toISOString() : null,
      reminderAt: null as string | null,
      contact: {
        id: row.contactId,
        name,
        email: row.contactEmail ?? null,
        phone: row.contactPhoneE164 ?? row.contactPhone ?? null,
        source: row.contactSource ?? null
      },
      account: row.accountId
        ? {
            id: row.accountId,
            name: row.accountName ?? company ?? name,
            status: row.accountStatus ?? null,
            segment: row.accountSegment ?? null,
            portalFit: row.accountPortalFit ?? null,
            fitScore: typeof row.accountFitScore === "number" ? row.accountFitScore : null,
            lastTouchAt:
              row.accountLastTouchAt instanceof Date
                ? row.accountLastTouchAt.toISOString()
                : null,
            nextTouchAt:
              row.accountNextTouchAt instanceof Date
                ? row.accountNextTouchAt.toISOString()
                : null,
          }
        : null
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

  const groupedMap = new Map<
    string,
    {
      id: string;
      key: string;
      name: string;
        status: string | null;
        segment: string | null;
        portalFit: string | null;
        fitScore: number | null;
        campaign: string | null;
      primaryTaskId: string;
      primaryContactId: string;
      title: string | null;
      dueAt: string | null;
      overdue: boolean;
      minutesUntilDue: number | null;
      attempt: number;
      lastDisposition: string | null;
      company: string | null;
      noteSnippet: string | null;
      startedAt: string | null;
      reminderAt: string | null;
      lastTouchAt: string | null;
      nextTouchAt: string | null;
      contacts: Array<{
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        source: string | null;
      }>;
      tasks: Array<{
        id: string;
        title: string | null;
        dueAt: string | null;
        attempt: number;
        lastDisposition: string | null;
        contactId: string;
        contactName: string;
      }>;
      taskIds: string[];
    }
  >();

  for (const item of filtered) {
    const key = item.account?.id
      ? `account:${item.account.id}`
      : `contact:${item.contact.id}`;
    const existing = groupedMap.get(key);
    if (!existing) {
      groupedMap.set(key, {
        id: item.account?.id ?? item.contact.id,
        key,
        name: item.account?.name ?? item.company ?? item.contact.name,
        status: item.account?.status ?? null,
        segment: item.account?.segment ?? null,
        portalFit: item.account?.portalFit ?? null,
        fitScore: item.account?.fitScore ?? null,
        campaign: item.campaign ?? null,
        primaryTaskId: item.id,
        primaryContactId: item.contact.id,
        title: item.title,
        dueAt: item.dueAt,
        overdue: item.overdue,
        minutesUntilDue: item.minutesUntilDue,
        attempt: item.attempt,
        lastDisposition: item.lastDisposition,
        company: item.company,
        noteSnippet: item.noteSnippet,
        startedAt: item.startedAt ?? null,
        reminderAt: item.reminderAt ?? null,
        lastTouchAt: item.account?.lastTouchAt ?? null,
        nextTouchAt: item.account?.nextTouchAt ?? null,
        contacts: [
          {
            id: item.contact.id,
            name: item.contact.name,
            email: item.contact.email ?? null,
            phone: item.contact.phone ?? null,
            source: item.contact.source ?? null,
          },
        ],
        tasks: [
          {
            id: item.id,
            title: item.title,
            dueAt: item.dueAt,
            attempt: item.attempt,
            lastDisposition: item.lastDisposition,
            contactId: item.contact.id,
            contactName: item.contact.name,
          },
        ],
        taskIds: [item.id],
      });
      continue;
    }

    existing.taskIds.push(item.id);
    if (
      existing.dueAt === null ||
      (item.dueAt !== null && Date.parse(item.dueAt) < Date.parse(existing.dueAt))
    ) {
      existing.primaryTaskId = item.id;
      existing.primaryContactId = item.contact.id;
      existing.title = item.title;
      existing.dueAt = item.dueAt;
      existing.overdue = item.overdue;
      existing.minutesUntilDue = item.minutesUntilDue;
      existing.attempt = item.attempt;
      existing.lastDisposition = item.lastDisposition;
      existing.noteSnippet = item.noteSnippet;
      existing.startedAt = item.startedAt ?? null;
      existing.reminderAt = item.reminderAt ?? null;
    }

    if (!existing.campaign && item.campaign) existing.campaign = item.campaign;
    if (!existing.segment && item.account?.segment) existing.segment = item.account.segment;
    if (!existing.status && item.account?.status) existing.status = item.account.status;
    if (!existing.portalFit && item.account?.portalFit) existing.portalFit = item.account.portalFit;
    if (existing.fitScore === null && typeof item.account?.fitScore === "number") existing.fitScore = item.account.fitScore;
    if (!existing.lastTouchAt && item.account?.lastTouchAt) existing.lastTouchAt = item.account.lastTouchAt;
    if (!existing.nextTouchAt && item.account?.nextTouchAt) existing.nextTouchAt = item.account.nextTouchAt;

    if (!existing.contacts.some((contact) => contact.id === item.contact.id)) {
      existing.contacts.push({
        id: item.contact.id,
        name: item.contact.name,
        email: item.contact.email ?? null,
        phone: item.contact.phone ?? null,
        source: item.contact.source ?? null,
      });
    }

    existing.tasks.push({
      id: item.id,
      title: item.title,
      dueAt: item.dueAt,
      attempt: item.attempt,
      lastDisposition: item.lastDisposition,
      contactId: item.contact.id,
      contactName: item.contact.name,
    });
  }

  const grouped = Array.from(groupedMap.values()).sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return a.name.localeCompare(b.name);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  });

  const total = grouped.length;
  const page = grouped.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : null;

  const selectedForBrief =
    (selectedAccountId
      ? page.find((item) => item.id === selectedAccountId)
      : null) ??
    (selectedTaskId
      ? page.find(
          (item) =>
            item.primaryTaskId === selectedTaskId || item.taskIds.includes(selectedTaskId),
        )
      : null) ??
    null;

  const briefByAccountId = new Map<string, Awaited<ReturnType<typeof ensureOutboundAccountBrief>>>();
  if (selectedForBrief?.key.startsWith("account:")) {
    const brief = await ensureOutboundAccountBrief({
      partnerAccountId: selectedForBrief.id,
    });
    if (brief) briefByAccountId.set(selectedForBrief.id, brief);
  }

  const pageIds = page.flatMap((item) => item.taskIds);
  if (pageIds.length > 0) {
    const taskIdExpr = sql<string>`(${outboxEvents.payload} ->> 'taskId')`;
    const idList = sql.join(
      pageIds.map((id) => sql`${id}`),
      sql`,`
    );

    const reminderRows = await db
      .select({ taskId: taskIdExpr, nextAttemptAt: outboxEvents.nextAttemptAt })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, "crm.reminder.sms"), sql`${taskIdExpr} in (${idList})`, sql`${outboxEvents.processedAt} is null`));

    const reminderMap = new Map<string, string>();
    for (const row of reminderRows) {
      if (!row.taskId || reminderMap.has(row.taskId)) continue;
      if (row.nextAttemptAt instanceof Date) reminderMap.set(row.taskId, row.nextAttemptAt.toISOString());
    }

    for (const item of page) {
      item.reminderAt = reminderMap.get(item.primaryTaskId) ?? null;
    }
  }

  const summary = grouped.reduce(
    (acc, item) => {
      const dueMs = item.dueAt ? Date.parse(item.dueAt) : null;
      if (dueMs !== null && dueMs <= now.getTime()) acc.dueNow += 1;
      if (dueMs !== null && dueMs < now.getTime()) acc.overdue += 1;
      if (dueMs === null) acc.notStarted += 1;
      const isCallback = (item.title ?? "").toLowerCase().includes("callback") || item.lastDisposition === "callback_requested";
      if (isCallback && dueMs !== null && dueMs >= startOfTodayUtcMs && dueMs <= endOfTodayUtcMs) acc.callbacksToday += 1;
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
    items: page.map((item) => ({
      id: item.id,
      title: item.title,
      dueAt: item.dueAt,
      overdue: item.overdue,
      minutesUntilDue: item.minutesUntilDue,
      attempt: item.attempt,
      campaign: item.campaign,
      lastDisposition: item.lastDisposition,
      company: item.company,
      noteSnippet: item.noteSnippet,
      startedAt: item.startedAt,
      reminderAt: item.reminderAt,
      primaryTaskId: item.primaryTaskId,
      primaryContactId: item.primaryContactId,
      taskIds: item.taskIds,
      contactCount: item.contacts.length,
      openTaskCount: item.tasks.length,
      contacts: item.contacts,
      tasks: item.tasks,
      account: {
        id: item.id,
        name: item.name,
        status: item.status,
        segment: item.segment,
        portalFit: item.portalFit,
        fitScore: item.fitScore,
        lastTouchAt: item.lastTouchAt,
        nextTouchAt: item.nextTouchAt,
        brief: briefByAccountId.get(item.id) ?? null,
      },
    }))
  });
}
