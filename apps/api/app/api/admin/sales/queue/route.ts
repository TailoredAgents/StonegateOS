import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm";
import {
  auditLogs,
  callRecords,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  crmTasks,
  getDb,
  properties
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getDisqualifiedContactIds, getLeadClockStart, getSalesScorecardConfig, getSpeedToLeadDeadline } from "@/lib/sales-scorecard";
import { getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";

function parseLeadId(notes: string | null): string | null {
  if (!notes) return null;
  const match = notes.match(/leadId=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function isSpeedTask(title: string): boolean {
  const t = title.toLowerCase();
  return t.includes("5 min sla") || t.includes("sla");
}

function parseTaskKind(notes: string | null, title: string): "speed_to_lead" | "follow_up" {
  const raw = typeof notes === "string" ? notes : "";
  if (/\bkind=speed_to_lead\b/i.test(raw)) return "speed_to_lead";
  if (/\bkind=follow_up\b/i.test(raw)) return "follow_up";
  return isSpeedTask(title) ? "speed_to_lead" : "follow_up";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);
  const serviceAreaPolicy = await getServiceAreaPolicy(db);

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
      contactCreatedAt: contacts.createdAt,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      pipelineStage: crmPipeline.stage
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, contacts.id))
    .where(
      and(
        eq(crmTasks.assignedTo, memberId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.dueAt),
        isNotNull(crmTasks.notes),
        ...(effectiveSince ? [gte(crmTasks.createdAt, effectiveSince)] : []),
        or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%")),
        or(isNull(crmPipeline.stage), notInArray(crmPipeline.stage, ["won", "lost", "quoted"]))
      )
    )
    .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(100);

  const disqualified = await getDisqualifiedContactIds({
    db,
    contactIds: rows.map((row) => row.contactId)
  });

  const dedupedRows: typeof rows = [];
  const seenTaskKeys = new Set<string>();
  for (const row of rows) {
    if (disqualified.has(row.contactId)) continue;
    const kind = parseTaskKind(row.notes ?? null, row.title);
    const key = `${row.contactId}:${kind}`;
    if (seenTaskKeys.has(key)) continue;
    seenTaskKeys.add(key);
    dedupedRows.push(row);
  }

  const items: Array<{
    id: string;
    leadId: string | null;
    contact: {
      id: string;
      name: string;
      phone: string | null;
      postalCode: string | null;
      serviceAreaStatus: "unknown" | "ok" | "potentially_out_of_area";
    };
    title: string;
    dueAt: string | null;
    overdue: boolean;
    minutesUntilDue: number | null;
    kind: "speed_to_lead" | "follow_up";
  }> = [];

  const postalCodeByContactId = new Map<string, string>();
  const contactIdsForLookup = Array.from(new Set(dedupedRows.map((row) => row.contactId))).filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );

  if (contactIdsForLookup.length) {
    const propertyRows = await db
      .select({
        contactId: properties.contactId,
        postalCode: properties.postalCode,
        createdAt: properties.createdAt
      })
      .from(properties)
      .where(inArray(properties.contactId, contactIdsForLookup.slice(0, 500)))
      .orderBy(desc(properties.createdAt))
      .limit(1000);

    for (const row of propertyRows) {
      if (!row.contactId || !row.postalCode) continue;
      if (postalCodeByContactId.has(row.contactId)) continue;
      postalCodeByContactId.set(row.contactId, row.postalCode);
    }
  }

  function getServiceAreaStatus(postalCode: string | null): "unknown" | "ok" | "potentially_out_of_area" {
    const normalized = postalCode ? normalizePostalCode(postalCode) : "";
    if (!normalized || normalized === "00000") return "unknown";
    return isPostalCodeAllowed(normalized, serviceAreaPolicy) ? "ok" : "potentially_out_of_area";
  }

  function getContactPostalCode(contactId: string): string | null {
    const postal = postalCodeByContactId.get(contactId);
    if (!postal) return null;
    const normalized = normalizePostalCode(postal);
    if (!normalized || normalized === "00000") return null;
    return normalized;
  }

  for (const row of dedupedRows) {
    const rawKind = parseTaskKind(row.notes ?? null, row.title);
    let kind: "speed_to_lead" | "follow_up" = rawKind;
    let title = row.title;
    let effectiveDueAt = row.dueAt instanceof Date ? row.dueAt : null;
    if (rawKind === "speed_to_lead" && row.contactCreatedAt instanceof Date) {
      const clockStart = getLeadClockStart(row.contactCreatedAt, config);
      const withinHours = clockStart.getTime() === row.contactCreatedAt.getTime();
      if (!withinHours) {
        title = "Auto: Call overnight lead (5 min SLA at open)";
        effectiveDueAt = getSpeedToLeadDeadline(row.contactCreatedAt, config);
      }
    }

    const dueAtIso = effectiveDueAt ? effectiveDueAt.toISOString() : null;
    const dueMs = effectiveDueAt ? effectiveDueAt.getTime() : null;
    const isOverdue = typeof dueMs === "number" ? dueMs < now.getTime() : false;
    const minutesUntilDue = typeof dueMs === "number" ? Math.round((dueMs - now.getTime()) / 60_000) : null;

    const postalCode = getContactPostalCode(row.contactId);
    items.push({
      id: row.id,
      leadId: parseLeadId(row.notes ?? null),
      contact: {
        id: row.contactId,
        name: `${row.contactFirst ?? ""} ${row.contactLast ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null,
        postalCode,
        serviceAreaStatus: getServiceAreaStatus(postalCode)
      },
      title,
      dueAt: dueAtIso,
      overdue: isOverdue,
      minutesUntilDue,
      kind
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
    or(isNull(crmPipeline.stage), notInArray(crmPipeline.stage, ["won", "lost", "quoted"]))
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

  const missingContactIds = missingRows.map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  const missingHasSalesTasks = new Set<string>();
  const missingHasTouch = new Set<string>();

  const missingPropertyLookup = missingContactIds.filter((contactId) => !postalCodeByContactId.has(contactId));
  if (missingPropertyLookup.length) {
    const propertyRows = await db
      .select({
        contactId: properties.contactId,
        postalCode: properties.postalCode,
        createdAt: properties.createdAt
      })
      .from(properties)
      .where(inArray(properties.contactId, missingPropertyLookup.slice(0, 500)))
      .orderBy(desc(properties.createdAt))
      .limit(1000);

    for (const row of propertyRows) {
      if (!row.contactId || !row.postalCode) continue;
      if (postalCodeByContactId.has(row.contactId)) continue;
      postalCodeByContactId.set(row.contactId, row.postalCode);
    }
  }

  if (missingContactIds.length) {
    const salesTaskRows = await db
      .select({ contactId: crmTasks.contactId })
      .from(crmTasks)
      .where(
        and(
          inArray(crmTasks.contactId, missingContactIds.slice(0, 250)),
          isNotNull(crmTasks.notes),
          or(ilike(crmTasks.notes, "%kind=speed_to_lead%"), ilike(crmTasks.notes, "%kind=follow_up%"))
        )
      )
      .limit(1000);

    for (const task of salesTaskRows) {
      if (typeof task.contactId === "string" && task.contactId.length > 0) {
        missingHasSalesTasks.add(task.contactId);
      }
    }

    const callTouchRows = await db
      .select({ contactId: auditLogs.entityId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "call.started"),
          eq(auditLogs.entityType, "contact"),
          eq(auditLogs.actorId, memberId),
          isNotNull(auditLogs.entityId),
          inArray(auditLogs.entityId, missingContactIds.slice(0, 250)),
          gte(auditLogs.createdAt, recentSince),
          lte(auditLogs.createdAt, now)
        )
      )
      .limit(250);

    for (const row of callTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }

    const outboundTouchRows = await db
      .select({ contactId: conversationThreads.contactId })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .innerJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
      .where(
        and(
          eq(conversationMessages.direction, "outbound"),
          eq(conversationParticipants.participantType, "team"),
          eq(conversationParticipants.teamMemberId, memberId),
          isNotNull(conversationThreads.contactId),
          inArray(conversationThreads.contactId, missingContactIds.slice(0, 250)),
          gte(conversationMessages.createdAt, recentSince),
          lte(conversationMessages.createdAt, now)
        )
      )
      .limit(250);

    for (const row of outboundTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }

    const inboundCallTouchRows = await db
      .select({ contactId: callRecords.contactId })
      .from(callRecords)
      .where(
        and(
          eq(callRecords.direction, "inbound"),
          eq(callRecords.callStatus, "completed"),
          eq(callRecords.assignedTo, memberId),
          isNotNull(callRecords.contactId),
          isNotNull(callRecords.callDurationSec),
          gt(callRecords.callDurationSec, 0),
          inArray(callRecords.contactId, missingContactIds.slice(0, 250)),
          gte(callRecords.createdAt, recentSince),
          lte(callRecords.createdAt, now)
        )
      )
      .limit(250);

    for (const row of inboundCallTouchRows) {
      if (typeof row.contactId === "string" && row.contactId.length > 0) {
        missingHasTouch.add(row.contactId);
      }
    }
  }

  for (const row of missingRows) {
    if (missingHasSalesTasks.has(row.id)) continue;
    if (missingHasTouch.has(row.id)) continue;

    const clockStart = getLeadClockStart(row.createdAt, config);
    const withinHours = clockStart.getTime() === row.createdAt.getTime();
    const deadline = getSpeedToLeadDeadline(row.createdAt, config);
    const hasPhone = Boolean((row.phoneE164 ?? row.phone ?? "").trim().length);
    if (!hasPhone) continue;

    if (!withinHours) {
      const dueMs = clockStart.getTime();
      const postalCode = getContactPostalCode(row.id);
      items.push({
        id: `contact:${row.id}`,
        leadId: null,
        contact: {
          id: row.id,
          name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact",
          phone: row.phoneE164 ?? row.phone ?? null,
          postalCode,
          serviceAreaStatus: getServiceAreaStatus(postalCode)
        },
        title: "Auto: Call overnight lead (at open)",
        dueAt: clockStart.toISOString(),
        overdue: dueMs < now.getTime(),
        minutesUntilDue: Math.round((dueMs - now.getTime()) / 60_000),
        kind: "follow_up"
      });
      continue;
    }

    const dueMs = deadline.getTime();
    const postalCode = getContactPostalCode(row.id);
    items.push({
      id: `contact:${row.id}`,
      leadId: null,
      contact: {
        id: row.id,
        name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "Contact",
        phone: row.phoneE164 ?? row.phone ?? null,
        postalCode,
        serviceAreaStatus: getServiceAreaStatus(postalCode)
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
