import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getDb,
  contacts,
  properties,
  appointments,
  quotes,
  crmPipeline,
  crmTasks
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../web/admin";
import { normalizePhone } from "../../web/utils";
import { forwardGeocode } from "@/lib/geocode";
import type { SQL } from "drizzle-orm";
import { asc, desc, inArray, ilike, or, sql } from "drizzle-orm";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function sanitizeSearchTerm(term: string): string {
  return term.replace(/[%_]/g, "\\$&").replace(/\s+/g, " ").trim();
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const { searchParams } = request.nextUrl;
  const rawSearch = searchParams.get("q");
  const searchTerm = rawSearch ? sanitizeSearchTerm(rawSearch) : null;
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const likePattern =
    searchTerm && searchTerm.length > 0 ? `%${searchTerm.replace(/\s+/g, "%")}%` : null;

  let propertyContactIds: string[] = [];
  if (likePattern) {
    const propertyMatches = await db
      .select({ contactId: properties.contactId })
      .from(properties)
      .where(
        or(
          ilike(properties.addressLine1, likePattern),
          ilike(properties.addressLine2, likePattern),
          ilike(properties.city, likePattern),
          ilike(properties.state, likePattern),
          ilike(properties.postalCode, likePattern)
        )
      );
    propertyContactIds = propertyMatches
      .map((row) => row.contactId)
      .filter((id): id is string => Boolean(id));
    propertyContactIds = Array.from(new Set(propertyContactIds));
  }

  const filters: SQL<unknown>[] = [];

  if (likePattern) {
    filters.push(
      ilike(contacts.firstName, likePattern),
      ilike(contacts.lastName, likePattern),
      ilike(contacts.email, likePattern),
      ilike(contacts.phone, likePattern),
      ilike(contacts.phoneE164, likePattern)
    );
    if (propertyContactIds.length > 0) {
      filters.push(inArray(contacts.id, propertyContactIds));
    }
  }

  const whereClause =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : or(...filters);

  const totalResult = whereClause
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(contacts)
        .where(whereClause)
    : await db.select({ count: sql<number>`count(*)` }).from(contacts);
  const total = Number(totalResult[0]?.count ?? 0);

  const baseContactsQuery = db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt
    })
    .from(contacts);

  const contactRows = await (whereClause
    ? baseContactsQuery.where(whereClause).orderBy(desc(contacts.updatedAt)).limit(limit).offset(offset)
    : baseContactsQuery.orderBy(desc(contacts.updatedAt)).limit(limit).offset(offset));

  const contactIds = contactRows.map((row) => row.id);

  const propertyRows =
    contactIds.length > 0
      ? await db
          .select({
            id: properties.id,
            contactId: properties.contactId,
            addressLine1: properties.addressLine1,
            addressLine2: properties.addressLine2,
            city: properties.city,
            state: properties.state,
            postalCode: properties.postalCode,
            createdAt: properties.createdAt
          })
          .from(properties)
          .where(inArray(properties.contactId, contactIds))
      : [];

  const pipelineRows =
    contactIds.length > 0
      ? await db
          .select({
            contactId: crmPipeline.contactId,
            stage: crmPipeline.stage,
            notes: crmPipeline.notes,
            updatedAt: crmPipeline.updatedAt
          })
          .from(crmPipeline)
          .where(inArray(crmPipeline.contactId, contactIds))
      : [];

  const taskRows =
    contactIds.length > 0
      ? await db
          .select({
            id: crmTasks.id,
            contactId: crmTasks.contactId,
            title: crmTasks.title,
            dueAt: crmTasks.dueAt,
            assignedTo: crmTasks.assignedTo,
            status: crmTasks.status,
            notes: crmTasks.notes,
            createdAt: crmTasks.createdAt,
            updatedAt: crmTasks.updatedAt
          })
          .from(crmTasks)
          .where(inArray(crmTasks.contactId, contactIds))
          .orderBy(
            sql`case when ${crmTasks.status} = 'open' then 0 else 1 end`,
            asc(crmTasks.dueAt),
            desc(crmTasks.createdAt)
          )
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

  const propertyMap = new Map<string, typeof propertyRows>();
  for (const property of propertyRows) {
    if (!property.contactId) continue;
    if (!propertyMap.has(property.contactId)) {
      propertyMap.set(property.contactId, []);
    }
    propertyMap.get(property.contactId)!.push(property);
  }

  const pipelineMap = new Map<
    string,
    { stage: string; notes: string | null; updatedAt: Date | null }
  >();
  for (const pipeline of pipelineRows) {
    if (!pipeline.contactId) continue;
    pipelineMap.set(pipeline.contactId, {
      stage: pipeline.stage ?? "new",
      notes: pipeline.notes ?? null,
      updatedAt: pipeline.updatedAt ?? null
    });
  }

  const tasksMap = new Map<string, typeof taskRows>();
  for (const task of taskRows) {
    if (!task.contactId) continue;
    if (!tasksMap.has(task.contactId)) {
      tasksMap.set(task.contactId, []);
    }
    tasksMap.get(task.contactId)!.push(task);
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

  const contactsDto = contactRows.map((contact) => {
    const propertiesForContact = propertyMap.get(contact.id) ?? [];
    const appointmentStat = appointmentMap.get(contact.id);
    const quoteStat = quoteMap.get(contact.id);
    const pipeline = pipelineMap.get(contact.id);
    const tasksForContact = tasksMap.get(contact.id) ?? [];

    const dates = [
      toDate(contact.updatedAt),
      toDate(appointmentStat?.latest ?? null),
      toDate(quoteStat?.latest ?? null)
    ];
    const lastActivity =
      dates
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    const fullName = `${contact.firstName} ${contact.lastName}`.trim();

    return {
      id: contact.id,
      name: fullName,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      phoneE164: contact.phoneE164,
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      pipeline: {
        stage: pipeline?.stage ?? "new",
        notes: pipeline?.notes ?? null,
        updatedAt: pipeline?.updatedAt ? pipeline.updatedAt.toISOString() : null
      },
      properties: propertiesForContact.map((property) => ({
        id: property.id,
        addressLine1: property.addressLine1,
        addressLine2: property.addressLine2,
        city: property.city,
        state: property.state,
        postalCode: property.postalCode,
        createdAt: property.createdAt.toISOString()
      })),
      tasks: tasksForContact.map((task) => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt ? task.dueAt.toISOString() : null,
        assignedTo: task.assignedTo,
        status: task.status,
        notes: task.notes,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString()
      })),
      stats: {
        appointments: appointmentStat?.count ?? 0,
        quotes: quoteStat?.count ?? 0
      }
    };
  });

  const nextOffset = offset + contactsDto.length;

  return NextResponse.json({
    contacts: contactsDto,
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null
    }
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const {
    firstName,
    lastName,
    email,
    phone,
    property: propertyInput
  } = payload as Record<string, unknown>;

  if (typeof firstName !== "string" || firstName.trim().length === 0) {
    return NextResponse.json({ error: "first_name_required" }, { status: 400 });
  }
  if (typeof lastName !== "string" || lastName.trim().length === 0) {
    return NextResponse.json({ error: "last_name_required" }, { status: 400 });
  }
  if (!propertyInput || typeof propertyInput !== "object") {
    return NextResponse.json({ error: "property_required" }, { status: 400 });
  }

  const {
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode
  } = propertyInput as Record<string, unknown>;

  if (typeof addressLine1 !== "string" || addressLine1.trim().length === 0) {
    return NextResponse.json({ error: "address_required" }, { status: 400 });
  }
  if (typeof city !== "string" || city.trim().length === 0) {
    return NextResponse.json({ error: "city_required" }, { status: 400 });
  }
  if (typeof state !== "string" || state.trim().length === 0) {
    return NextResponse.json({ error: "state_required" }, { status: 400 });
  }
  if (typeof postalCode !== "string" || postalCode.trim().length === 0) {
    return NextResponse.json({ error: "postal_code_required" }, { status: 400 });
  }

  let normalizedPhone: { raw: string; e164: string } | null = null;
  if (typeof phone === "string" && phone.trim().length > 0) {
    try {
      normalizedPhone = normalizePhone(phone);
    } catch {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const geo = await forwardGeocode({
        addressLine1: addressLine1.trim(),
        city: city.trim(),
        state: state.trim().slice(0, 2).toUpperCase(),
        postalCode: postalCode.trim()
      });

      const [contact] = await tx
        .insert(contacts)
        .values({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: typeof email === "string" && email.trim().length ? email.trim() : null,
          phone: normalizedPhone?.raw ?? (typeof phone === "string" ? phone.trim() : null),
          phoneE164: normalizedPhone?.e164 ?? null,
          source: "manual",
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning();

      if (!contact) {
        throw new Error("contact_insert_failed");
      }

      const [property] = await tx
        .insert(properties)
        .values({
          contactId: contact.id,
          addressLine1: addressLine1.trim(),
          addressLine2:
            typeof addressLine2 === "string" && addressLine2.trim().length
              ? addressLine2.trim()
              : null,
          city: city.trim(),
          state: state.trim().slice(0, 2).toUpperCase(),
          postalCode: postalCode.trim(),
          lat: geo?.lat !== undefined && geo?.lat !== null ? geo.lat.toString() : null,
          lng: geo?.lng !== undefined && geo?.lng !== null ? geo.lng.toString() : null
        })
        .returning();

      await tx
        .insert(crmPipeline)
        .values({
          contactId: contact.id,
          stage: "new",
          notes: null
        })
        .onConflictDoNothing({
          target: crmPipeline.contactId
        });

      return { contact, property };
    });

    const { contact, property } = result;

    await recordAuditEvent({
      actor,
      action: "contact.created",
      entityType: "contact",
      entityId: contact.id,
      meta: {
        propertyId: property?.id ?? null,
        source: "manual"
      }
    });

    if (property?.id) {
      await recordAuditEvent({
        actor,
        action: "property.created",
        entityType: "property",
        entityId: property.id,
        meta: { contactId: contact.id }
      });
    }

    return NextResponse.json({
      contact: {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        phoneE164: contact.phoneE164,
        createdAt: contact.createdAt.toISOString(),
        updatedAt: contact.updatedAt.toISOString(),
        pipeline: {
          stage: "new",
          notes: null,
          updatedAt: contact.updatedAt.toISOString()
        },
        property: property
          ? {
              id: property.id,
              addressLine1: property.addressLine1,
              addressLine2: property.addressLine2,
              city: property.city,
              state: property.state,
              postalCode: property.postalCode
            }
          : null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "contact_create_failed";
    const status = message === "contact_insert_failed" ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
