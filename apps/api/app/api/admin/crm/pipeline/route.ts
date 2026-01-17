import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getDb,
  crmPipeline,
  contacts,
  properties,
  appointments,
  quotes,
  crmTasks
} from "@/db";
import { getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";
import { isAdminRequest } from "../../../web/admin";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PIPELINE_STAGES } from "./stages";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();

  const pipelineRows = await db
    .select({
      contactId: crmPipeline.contactId,
      stage: crmPipeline.stage,
      notes: crmPipeline.notes,
      pipelineUpdatedAt: crmPipeline.updatedAt,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      source: contacts.source,
      updatedAt: contacts.updatedAt,
      createdAt: contacts.createdAt
    })
    .from(crmPipeline)
    .innerJoin(contacts, eq(crmPipeline.contactId, contacts.id));

  if (pipelineRows.length === 0) {
    return NextResponse.json({
      stages: PIPELINE_STAGES,
      lanes: PIPELINE_STAGES.map((stage) => ({ stage, contacts: [] }))
    });
  }

  const serviceArea = await getServiceAreaPolicy(db);

  const contactIds = pipelineRows.map((row) => row.contactId).filter((id): id is string => Boolean(id));

  const propertyRows =
    contactIds.length > 0
      ? await db
          .select({
            id: properties.id,
            contactId: properties.contactId,
            addressLine1: properties.addressLine1,
            city: properties.city,
            state: properties.state,
            postalCode: properties.postalCode,
            createdAt: properties.createdAt
          })
          .from(properties)
          .where(inArray(properties.contactId, contactIds))
      : [];

  const appointmentStats =
    contactIds.length > 0
      ? await db
          .select({
            contactId: appointments.contactId,
            count: sql<number>`count(*)`,
            latest: sql<Date | null>`max(coalesce(${appointments.updatedAt}, ${appointments.startAt}))`
          })
          .from(appointments)
          .where(inArray(appointments.contactId, contactIds))
          .groupBy(appointments.contactId)
      : [];

  const quoteStats =
    contactIds.length > 0
      ? await db
          .select({
            contactId: quotes.contactId,
            count: sql<number>`count(*)`,
            latest: sql<Date | null>`max(${quotes.updatedAt})`
          })
          .from(quotes)
          .where(inArray(quotes.contactId, contactIds))
          .groupBy(quotes.contactId)
      : [];

  const noteStats =
    contactIds.length > 0
      ? await db
          .select({
            contactId: crmTasks.contactId,
            count: sql<number>`count(*)`,
            latest: sql<Date | null>`max(${crmTasks.updatedAt})`
          })
          .from(crmTasks)
          .where(inArray(crmTasks.contactId, contactIds))
          .groupBy(crmTasks.contactId)
      : [];

  const primaryPropertyByContact = new Map<string, (typeof propertyRows)[number]>();
  for (const property of propertyRows) {
    if (!property.contactId) continue;
    const current = primaryPropertyByContact.get(property.contactId);
    if (!current) {
      primaryPropertyByContact.set(property.contactId, property);
      continue;
    }
    if (property.createdAt > current.createdAt) {
      primaryPropertyByContact.set(property.contactId, property);
    }
  }

  const appointmentMap = new Map<string, { count: number; latest: Date | null }>();
  for (const stat of appointmentStats) {
    if (!stat.contactId) continue;
    appointmentMap.set(stat.contactId, { count: Number(stat.count), latest: stat.latest });
  }

  const quoteMap = new Map<string, { count: number; latest: Date | null }>();
  for (const stat of quoteStats) {
    if (!stat.contactId) continue;
    quoteMap.set(stat.contactId, { count: Number(stat.count), latest: stat.latest });
  }

  const noteMap = new Map<string, { count: number; latest: Date | null }>();
  for (const stat of noteStats) {
    if (!stat.contactId) continue;
    noteMap.set(stat.contactId, { count: Number(stat.count), latest: stat.latest });
  }

  const lanes = PIPELINE_STAGES.map((stage) => ({ stage, contacts: [] as Array<Record<string, unknown>> }));
  const laneLookup = new Map<string, (typeof lanes)[number]>();
  for (const lane of lanes) {
    laneLookup.set(lane.stage, lane);
  }

  for (const row of pipelineRows) {
    const contactId = row.contactId;
    if (!contactId) continue;
    const stage = (row.stage ?? "new").toLowerCase();
    const lane = laneLookup.get(stage) ?? laneLookup.get("new");
    if (!lane) continue;

    const property = primaryPropertyByContact.get(contactId);
    const normalizedPostalCode = property?.postalCode ? normalizePostalCode(property.postalCode) : null;
    const outOfArea =
      normalizedPostalCode !== null ? !isPostalCodeAllowed(normalizedPostalCode, serviceArea) : null;
    const appointmentStat = appointmentMap.get(contactId);
    const quoteStat = quoteMap.get(contactId);
    const notes = noteMap.get(contactId) ?? { count: 0, latest: null };

    const dates = [
      toDate(row.updatedAt),
      toDate(row.pipelineUpdatedAt ?? null),
      toDate(appointmentStat?.latest ?? null),
      toDate(quoteStat?.latest ?? null),
      toDate(notes.latest ?? null)
    ];

    const lastActivity =
      dates
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    lane.contacts.push({
      id: contactId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
      source: row.source ?? null,
      pipeline: {
        stage,
        notes: row.notes ?? null,
        updatedAt: row.pipelineUpdatedAt ? row.pipelineUpdatedAt.toISOString() : null
      },
      property: property
        ? {
            id: property.id,
            addressLine1: property.addressLine1,
            city: property.city,
            state: property.state,
            postalCode: property.postalCode,
            outOfArea
          }
        : null,
      stats: {
        appointments: appointmentStat?.count ?? 0,
        quotes: quoteStat?.count ?? 0
      },
      notesCount: notes.count,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString()
    });
  }

  for (const lane of lanes) {
    lane.contacts.sort((a, b) => {
      const aTime = typeof a["lastActivityAt"] === "string" ? Date.parse(a["lastActivityAt"]) : 0;
      const bTime = typeof b["lastActivityAt"] === "string" ? Date.parse(b["lastActivityAt"]) : 0;
      return bTime - aTime;
    });
  }

  return NextResponse.json({ stages: PIPELINE_STAGES, lanes });
}
function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
