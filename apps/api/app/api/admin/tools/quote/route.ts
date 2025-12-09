import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates, zones } from "@myst-os/pricing/src/config/defaults";
import type { ServiceCategory } from "@myst-os/pricing/src/types";
import { getDb, appointments, contacts, leads, properties, quotes } from "@/db";
import { isAdminRequest } from "../../../web/admin";

type CreateQuotePayload = {
  appointmentId?: string;
  contactId?: string;
  propertyId?: string;
  services?: string[];
  notes?: string;
  zoneId?: string;
  expiresInDays?: number;
};

const SERVICE_IDS = new Set<ServiceCategory>(serviceRates.map((rate) => rate.service));
const DEFAULT_ZONE_ID = zones[0]?.id ?? "zone-core";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as CreateQuotePayload | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  let contactId = typeof payload.contactId === "string" ? payload.contactId.trim() : "";
  let propertyId = typeof payload.propertyId === "string" ? payload.propertyId.trim() : "";
  const appointmentId = typeof payload.appointmentId === "string" ? payload.appointmentId.trim() : "";
  const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
  const zoneId =
    typeof payload.zoneId === "string" && payload.zoneId.trim().length ? payload.zoneId.trim() : DEFAULT_ZONE_ID;
  const expiresInDays =
    typeof payload.expiresInDays === "number" && Number.isFinite(payload.expiresInDays) && payload.expiresInDays > 0
      ? Math.floor(payload.expiresInDays)
      : null;

  const db = getDb();

  let leadServices: string[] = [];
  if (appointmentId.length) {
    const [appt] = await db
      .select({
        id: appointments.id,
        contactId: appointments.contactId,
        propertyId: appointments.propertyId,
        leadServices: leads.servicesRequested
      })
      .from(appointments)
      .leftJoin(leads, eq(appointments.leadId, leads.id))
      .where(eq(appointments.id, appointmentId))
      .limit(1);

    if (!appt) {
      return NextResponse.json({ error: "appointment_not_found" }, { status: 404 });
    }

    if (!contactId.length && appt.contactId) contactId = appt.contactId;
    if (!propertyId.length && appt.propertyId) propertyId = appt.propertyId;
    if (Array.isArray(appt.leadServices)) {
      leadServices = appt.leadServices.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    }
  }

  if (!contactId.length) {
    return NextResponse.json({ error: "contact_required" }, { status: 400 });
  }
  if (!propertyId.length) {
    return NextResponse.json({ error: "property_required" }, { status: 400 });
  }

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const [property] = await db
    .select({
      id: properties.id,
      contactId: properties.contactId,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);

  if (!property) {
    return NextResponse.json({ error: "property_not_found" }, { status: 404 });
  }
  if (property.contactId !== contact.id) {
    return NextResponse.json({ error: "property_contact_mismatch" }, { status: 400 });
  }

  const selectedServices = deriveServices(payload.services, leadServices);
  const breakdown = calculateQuoteBreakdown({
    zoneId,
    selectedServices,
    selectedAddOns: [],
    applyBundles: false
  });

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const values: typeof quotes.$inferInsert = {
    contactId: contact.id,
    propertyId: property.id,
    status: "pending",
    services: selectedServices,
    addOns: null,
    surfaceArea: null,
    zoneId,
    travelFee: toPgNumeric(breakdown.travelFee),
    discounts: toPgNumeric(breakdown.discounts),
    addOnsTotal: toPgNumeric(breakdown.addOnsTotal),
    subtotal: toPgNumeric(breakdown.subtotal),
    total: toPgNumeric(breakdown.total),
    depositDue: toPgNumeric(breakdown.depositDue),
    depositRate: toPgNumeric(breakdown.depositRate),
    balanceDue: toPgNumeric(breakdown.balanceDue),
    lineItems: breakdown.lineItems,
    notes: notes.length ? notes : null,
    expiresAt
  };

  const [inserted] = await db.insert(quotes).values(values).returning();

  if (!inserted) {
    return NextResponse.json({ error: "quote_insert_failed" }, { status: 500 });
  }

  const contactName =
    [contact.firstName, contact.lastName].filter((part) => typeof part === "string" && part.trim().length > 0).join(" ") ||
    "Customer";

  const summary = buildSummary({
    contactName,
    property,
    total: breakdown.total,
    services: selectedServices
  });

  return NextResponse.json({
    ok: true,
    quoteId: inserted.id,
    services: selectedServices,
    total: Number(inserted.total),
    summary
  });
}

function deriveServices(primary?: unknown, fallback?: unknown): ServiceCategory[] {
  const tokens: string[] = [];
  if (Array.isArray(primary)) {
    for (const value of primary) {
      if (typeof value === "string" && value.trim().length) {
        tokens.push(value.trim());
      }
    }
  }
  if (Array.isArray(fallback)) {
    for (const value of fallback) {
      if (typeof value === "string" && value.trim().length) {
        tokens.push(value.trim());
      }
    }
  }

  const mapped: ServiceCategory[] = [];
  for (const token of tokens) {
    const normalized = normalizeServiceToken(token);
    if (normalized && !mapped.includes(normalized)) {
      mapped.push(normalized);
    }
  }

  if (mapped.length === 0) {
    return ["other"];
  }

  return mapped;
}

function normalizeServiceToken(token: string): ServiceCategory | null {
  const trimmed = token.trim();
  if (!trimmed.length) return null;
  if (SERVICE_IDS.has(trimmed as ServiceCategory)) {
    return trimmed as ServiceCategory;
  }

  const lower = trimmed.toLowerCase();

  const keywordMap: Array<[ServiceCategory, RegExp]> = [
    ["single-item", /(single|item|tv|mattress)/i],
    ["furniture", /(furniture|sofa|couch|dresser|bed|chair)/i],
    ["appliances", /(appliance|fridge|freezer|washer|dryer|stove|oven|microwave)/i],
    ["yard-waste", /(yard|brush|green|tree|branch|leaves|yard waste)/i],
    ["construction-debris", /(construction|debris|demo|renovation|remodel|junk|load)/i],
    ["hot-tub", /(hot[ -]?tub|spa|jacuzzi)/i],
    ["driveway", /(driveway|concrete|oil stain)/i],
    ["roof", /(roof)/i],
    ["deck", /(deck|patio|porch)/i],
    ["gutter", /(gutter)/i],
    ["commercial", /(commercial|store|retail|office)/i]
  ];

  for (const [service, pattern] of keywordMap) {
    if (pattern.test(lower)) {
      return service;
    }
  }

  return SERVICE_IDS.has("other" as ServiceCategory) ? ("other" as ServiceCategory) : null;
}

function toPgNumeric(value: number | string): string {
  return value.toString();
}

function buildSummary(input: {
  contactName: string;
  property: { addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null };
  services: ServiceCategory[];
  total: number;
}): string {
  const addressParts = [
    input.property.addressLine1,
    input.property.city,
    input.property.state,
    input.property.postalCode
  ].filter((part) => typeof part === "string" && part.trim().length > 0);

  const address = addressParts.join(", " );
  const svc = input.services.join(", " );
  const total = fmtMoney(input.total);
  return (
    "Quote created for " +
    input.contactName +
    (address ? " at " + address : "") +
    " (" +
    svc +
    ") - est. " +
    total +
    "."
  );
}

function fmtMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "$0.00";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}
