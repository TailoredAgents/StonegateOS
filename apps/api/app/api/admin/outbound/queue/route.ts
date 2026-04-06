import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { auditLogs, contacts, crmTasks, getDb, outboxEvents, partnerAccounts } from "@/db";
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

type AccountHistoryEntry = {
  id: string;
  at: string;
  kind: "import" | "draft" | "disposition" | "recap" | "task" | "partner" | "note";
  title: string;
  summary: string;
  contactName: string | null;
};

function labelDisposition(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return "Updated";
  return normalized.replace(/_/g, " ");
}

function normalizeIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function isRelevantOutboundHistoryTask(title: string | null, notes: string | null): boolean {
  const normalizedTitle = typeof title === "string" ? title.trim().toLowerCase() : "";
  const normalizedNotes = typeof notes === "string" ? notes.trim().toLowerCase() : "";
  if (!normalizedTitle && !normalizedNotes) return false;
  if (normalizedNotes.includes("kind=outbound")) return true;
  if (normalizedNotes.startsWith("outbound recap (")) return true;
  if (normalizedNotes.startsWith("outbound updated:")) return true;
  if (normalizedNotes.startsWith("outbound connected")) return true;
  if (normalizedNotes.startsWith("outbound converted to partner")) return true;
  if (
    normalizedTitle === "note" &&
    ["company:", "title:", "industry:", "company size:", "website:", "linkedin:", "source list:", "segment:", "subsegment:"].some((marker) =>
      normalizedNotes.includes(marker),
    )
  ) {
    return true;
  }
  return false;
}

function buildTaskHistoryEntry(row: {
  id: string;
  title: string | null;
  status: string;
  notes: string | null;
  dueAt: Date | null;
  createdAt: Date;
  contactId: string;
  contactFirst: string | null;
  contactLast: string | null;
}): AccountHistoryEntry | null {
  const notes = typeof row.notes === "string" ? row.notes.trim() : "";
  const contactName = `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim() || null;
  if (!isRelevantOutboundHistoryTask(row.title, row.notes)) return null;

  if (notes.toLowerCase().startsWith("outbound recap (")) {
    const summary = notes.replace(/^Outbound recap \([^)]+\):\s*/i, "").trim();
    return {
      id: `task:${row.id}:recap`,
      at: row.createdAt.toISOString(),
      kind: "recap",
      title: "Recap saved",
      summary: summary || "Conversation recap saved for the next touch.",
      contactName,
    };
  }

  if (notes.toLowerCase().startsWith("outbound converted to partner")) {
    return {
      id: `task:${row.id}:partner`,
      at: row.createdAt.toISOString(),
      kind: "partner",
      title: "Converted to partner",
      summary: "Outbound relationship moved into the partner workflow.",
      contactName,
    };
  }

  if (notes.toLowerCase().startsWith("outbound connected")) {
    return {
      id: `task:${row.id}:connected`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Conversation started",
      summary: "Cadence was stopped because a real conversation was established.",
      contactName,
    };
  }

  if (notes.toLowerCase().startsWith("outbound updated:")) {
    const disposition = notes.replace(/^Outbound updated:\s*/i, "").trim();
    return {
      id: `task:${row.id}:updated`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Disposition logged",
      summary: disposition ? `Marked as ${labelDisposition(disposition)}.` : "Outbound status was updated.",
      contactName,
    };
  }

  if (notes.toLowerCase().includes("kind=outbound")) {
    const attempt = parseField(notes, "attempt");
    const campaign = parseField(notes, "campaign");
    const summaryBits = [
      attempt ? `Attempt ${attempt}` : null,
      campaign,
      row.dueAt instanceof Date ? `Due ${row.dueAt.toISOString()}` : row.status === "open" ? "Not started yet" : null,
    ].filter(Boolean);
    return {
      id: `task:${row.id}:cadence`,
      at: row.createdAt.toISOString(),
      kind: "task",
      title: row.title ?? (row.status === "open" ? "Outbound task" : "Completed outbound task"),
      summary: summaryBits.length ? summaryBits.join(" / ") : "Outbound cadence activity.",
      contactName,
    };
  }

  return {
    id: `task:${row.id}:note`,
    at: row.createdAt.toISOString(),
    kind: "note",
    title: "Research note added",
    summary: notes.split("\n").slice(0, 2).join(" / ").trim() || "Account research details were saved.",
    contactName,
  };
}

function buildAuditHistoryEntry(
  row: {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    meta: Record<string, unknown> | null;
    createdAt: Date;
  },
  contactNameById: Map<string, string>,
): AccountHistoryEntry | null {
  const meta = row.meta ?? {};
  const contactId = typeof meta["contactId"] === "string" ? meta["contactId"] : null;
  const contactName = (contactId ? contactNameById.get(contactId) : null) ?? null;

  if (row.action === "outbound.imported") {
    const campaign = typeof meta["campaign"] === "string" ? meta["campaign"] : null;
    const source = typeof meta["source"] === "string" ? meta["source"] : null;
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "import",
      title: "Imported prospect",
      summary: [campaign, source].filter(Boolean).join(" / ") || "Prospect imported into outbound.",
      contactName,
    };
  }

  if (row.action === "outbound.draft_created") {
    const kind = typeof meta["kind"] === "string" ? meta["kind"] : null;
    const channel = typeof meta["channel"] === "string" ? meta["channel"] : null;
    const disposition = typeof meta["disposition"] === "string" ? meta["disposition"] : null;
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "draft",
      title: kind === "follow_up" ? "Drafted follow-up" : "Drafted first outreach",
      summary: [channel ? channel.toUpperCase() : null, disposition ? `after ${labelDisposition(disposition)}` : null]
        .filter(Boolean)
        .join(" / ") || "Prepared an outreach draft in Inbox.",
      contactName,
    };
  }

  if (row.action === "outbound.disposition") {
    const disposition = typeof meta["disposition"] === "string" ? meta["disposition"] : null;
    const attempt = typeof meta["attempt"] === "number" ? meta["attempt"] : typeof meta["attempt"] === "string" ? Number(meta["attempt"]) : null;
    const hasRecap = Boolean(meta["hasRecap"]);
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Disposition logged",
      summary: [
        disposition ? labelDisposition(disposition) : null,
        typeof attempt === "number" && Number.isFinite(attempt) ? `Attempt ${attempt}` : null,
        hasRecap ? "recap saved" : null,
      ]
        .filter(Boolean)
        .join(" / ") || "Outbound disposition was recorded.",
      contactName,
    };
  }

  if (row.action === "partner.converted") {
    const partnerType = typeof meta["partnerType"] === "string" ? meta["partnerType"] : null;
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "partner",
      title: "Converted to partner",
      summary: partnerType ? `Suggested path: ${partnerType.replace(/_/g, " ")}` : "Outbound account converted into partner flow.",
      contactName,
    };
  }

  return null;
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

  const accountScoreFilters = [
    eq(partnerAccounts.ownerMemberId, assignedTo),
    or(ilike(partnerAccounts.source, "outbound:%"), isNotNull(partnerAccounts.sourceCampaign)),
  ];
  if (campaignFilter) {
    accountScoreFilters.push(eq(partnerAccounts.sourceCampaign, campaignFilter));
  }

  const accountScoreRows = await db
    .select({
      id: partnerAccounts.id,
      status: partnerAccounts.status,
      portalFit: partnerAccounts.portalFit,
      fitScore: partnerAccounts.fitScore,
      lastTouchAt: partnerAccounts.lastTouchAt,
    })
    .from(partnerAccounts)
    .where(and(...accountScoreFilters));

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
  const historyByAccountId = new Map<string, AccountHistoryEntry[]>();
  if (selectedForBrief?.key.startsWith("account:")) {
    const brief = await ensureOutboundAccountBrief({
      partnerAccountId: selectedForBrief.id,
    });
    if (brief) briefByAccountId.set(selectedForBrief.id, brief);

    const selectedContactIds = dedupeStrings(selectedForBrief.contacts.map((contact) => contact.id));
    const selectedTaskIds = dedupeStrings(selectedForBrief.taskIds);
    const contactNameById = new Map(
      selectedForBrief.contacts.map((contact) => [contact.id, contact.name] as const),
    );

    const taskHistoryRows = await db
      .select({
        id: crmTasks.id,
        title: crmTasks.title,
        status: crmTasks.status,
        notes: crmTasks.notes,
        dueAt: crmTasks.dueAt,
        createdAt: crmTasks.createdAt,
        contactId: crmTasks.contactId,
        contactFirst: contacts.firstName,
        contactLast: contacts.lastName,
      })
      .from(crmTasks)
      .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
      .where(eq(crmTasks.partnerAccountId, selectedForBrief.id))
      .orderBy(desc(crmTasks.createdAt))
      .limit(30);

    const auditPredicates = [];
    if (selectedContactIds.length > 0) {
      auditPredicates.push(and(eq(auditLogs.entityType, "contact"), inArray(auditLogs.entityId, selectedContactIds)));
      const contactIdList = sql.join(selectedContactIds.map((id) => sql`${id}`), sql`,`);
      auditPredicates.push(
        and(
          eq(auditLogs.entityType, "conversation_message"),
          sql`${auditLogs.meta} ->> 'contactId' in (${contactIdList})`,
        ),
      );
    }
    if (selectedTaskIds.length > 0) {
      auditPredicates.push(and(eq(auditLogs.entityType, "crm_task"), inArray(auditLogs.entityId, selectedTaskIds)));
    }

    const auditHistoryRows =
      auditPredicates.length > 0
        ? await db
            .select({
              id: auditLogs.id,
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              meta: auditLogs.meta,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .where(
              and(
                inArray(auditLogs.action, [
                  "outbound.imported",
                  "outbound.draft_created",
                  "outbound.disposition",
                  "partner.converted",
                ]),
                or(...auditPredicates),
              ),
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(40)
        : [];

    const history = [
      ...taskHistoryRows.map((row) => buildTaskHistoryEntry(row)),
      ...auditHistoryRows.map((row) => buildAuditHistoryEntry(row, contactNameById)),
    ]
      .filter((entry): entry is AccountHistoryEntry => Boolean(entry))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 12);

    historyByAccountId.set(selectedForBrief.id, history);
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

  const scoreboard = accountScoreRows.reduce(
    (acc, row) => {
      if (row.lastTouchAt instanceof Date) acc.accountsTouched += 1;

      if (
        row.status === "conversation_active" ||
        row.status === "qualified_partner" ||
        row.status === "trial_partner" ||
        row.status === "active_partner" ||
        row.status === "portal_partner" ||
        row.status === "managed_partner"
      ) {
        acc.conversationsStarted += 1;
      }

      if (
        row.status === "qualified_partner" ||
        row.status === "trial_partner" ||
        row.status === "active_partner" ||
        row.status === "portal_partner" ||
        row.status === "managed_partner"
      ) {
        acc.qualifiedPartners += 1;
      }

      if (
        row.status === "active_partner" ||
        row.status === "portal_partner" ||
        row.status === "managed_partner"
      ) {
        acc.activePartners += 1;
      }

      const normalizedFit = typeof row.portalFit === "string" ? row.portalFit.trim().toLowerCase() : "";
      if (normalizedFit === "portal_first") acc.partnerPathMix.portalFirst += 1;
      else if (normalizedFit === "managed_direct") acc.partnerPathMix.managedDirect += 1;
      else if (normalizedFit === "hybrid") acc.partnerPathMix.hybrid += 1;
      else if (normalizedFit === "not_a_fit") acc.partnerPathMix.notAFit += 1;

      if (typeof row.fitScore === "number" && Number.isFinite(row.fitScore)) {
        acc.fitScoreCount += 1;
        acc.fitScoreTotal += row.fitScore;
      }

      return acc;
    },
    {
      accountsTouched: 0,
      conversationsStarted: 0,
      qualifiedPartners: 0,
      activePartners: 0,
      partnerPathMix: {
        portalFirst: 0,
        managedDirect: 0,
        hybrid: 0,
        notAFit: 0,
      },
      fitScoreCount: 0,
      fitScoreTotal: 0,
    },
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
    summary: {
      ...summary,
      scoreboard: {
        accountsTouched: scoreboard.accountsTouched,
        conversationsStarted: scoreboard.conversationsStarted,
        qualifiedPartners: scoreboard.qualifiedPartners,
        activePartners: scoreboard.activePartners,
        avgFitScore:
          scoreboard.fitScoreCount > 0
            ? Math.round(scoreboard.fitScoreTotal / scoreboard.fitScoreCount)
            : null,
        partnerPathMix: scoreboard.partnerPathMix,
      },
    },
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
        history: historyByAccountId.get(item.id) ?? [],
      },
    }))
  });
}
