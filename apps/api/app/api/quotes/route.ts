import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type { ConcreteSurfaceInput, ServiceCategory } from "@myst-os/pricing/src/types";
import { getDb, quotes, contacts, properties } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../web/admin";
import { eq, desc } from "drizzle-orm";

const STATUS_FILTERS = ["pending", "sent", "accepted", "declined"] as const;
type QuoteStatusFilter = (typeof STATUS_FILTERS)[number];

const SERVICE_ID_SET = new Set<ServiceCategory>(serviceRates.map((rate) => rate.service));

const serviceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value): value is ServiceCategory => SERVICE_ID_SET.has(value as ServiceCategory),
    "invalid_service"
  );

const CreateQuoteSchema = z.object({
  contactId: z.string().uuid(),
  propertyId: z.string().uuid(),
  zoneId: z.string().min(1),
  selectedServices: z.array(serviceIdSchema).min(1),
  selectedAddOns: z.array(z.string().min(1)).optional(),
  surfaceArea: z.number().positive().optional(),
  applyBundles: z.boolean().optional(),
  depositRate: z.number().positive().max(1).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  notes: z.string().max(2000).optional(),
  serviceOverrides: z.record(z.string().min(1), z.number().positive()).optional(),
  concreteSurfaces: z
    .array(
      z.object({
        kind: z.enum(["driveway", "deck", "other"]),
        squareFeet: z.number().positive()
      })
    )
    .max(3)
    .optional()
});

const toPgNumeric = (value: number | string): string => value.toString();
const toOptionalPgNumeric = (value?: number | string | null): string | null =>
  value === null || value === undefined ? null : value.toString();

function formatQuoteResponse(row: {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: unknown;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  expiresAt: Date | null;
  shareToken: string | null;
  contactName: string | null;
  contactEmail: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyPostalCode: string | null;
}) {
  const contactName = row.contactName?.trim();
  const addressLine1 = row.propertyAddressLine1?.trim();
  const city = row.propertyCity?.trim();
  const state = row.propertyState?.trim();
  const postalCode = row.propertyPostalCode?.trim();

  return {
    id: row.id,
    status: row.status,
    services: row.services,
    addOns: row.addOns,
    total: Number(row.total),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    shareToken: row.shareToken,
    contact: {
      name: contactName && contactName.length ? contactName : "Customer",
      email: row.contactEmail
    },
    property: {
      addressLine1: addressLine1 ?? "",
      city: city ?? "",
      state: state ?? "",
      postalCode: postalCode ?? ""
    }
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const statusParam = request.nextUrl.searchParams.get("status");
  const statusFilter: QuoteStatusFilter | null = STATUS_FILTERS.includes(
    statusParam as QuoteStatusFilter
  )
    ? (statusParam as QuoteStatusFilter)
    : null;

  const db = getDb();
  const baseQuery = db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      total: quotes.total,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      shareToken: quotes.shareToken,
      contactName: contacts.firstName,
      contactEmail: contacts.email,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id));

  const filteredQuery = statusFilter
    ? baseQuery.where(eq(quotes.status, statusFilter))
    : baseQuery;

  const rows = await filteredQuery.orderBy(desc(quotes.updatedAt));

  return NextResponse.json({
    quotes: rows.map(formatQuoteResponse)
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsedBody = CreateQuoteSchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsedBody.data;
  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  const [contact] = await db
    .select({
      id: contacts.id,
      name: contacts.firstName
    })
    .from(contacts)
    .where(eq(contacts.id, body.contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const [property] = await db
    .select({
      id: properties.id,
      contactId: properties.contactId
    })
    .from(properties)
    .where(eq(properties.id, body.propertyId))
    .limit(1);

  if (!property) {
    return NextResponse.json({ error: "property_not_found" }, { status: 404 });
  }

  if (property.contactId !== contact.id) {
    return NextResponse.json({ error: "property_contact_mismatch" }, { status: 400 });
  }

  const selectedServices = body.selectedServices as ServiceCategory[];
  const sanitizedOverrides: Partial<Record<ServiceCategory, number>> = {};
  if (body.serviceOverrides) {
    for (const [serviceId, amount] of Object.entries(body.serviceOverrides)) {
      if (
        SERVICE_ID_SET.has(serviceId as ServiceCategory) &&
        serviceId !== "driveway" &&
        selectedServices.includes(serviceId as ServiceCategory) &&
        typeof amount === "number" &&
        amount > 0
      ) {
        sanitizedOverrides[serviceId as ServiceCategory] = amount;
      }
    }
  }

  const concreteSurfaces = (body.concreteSurfaces ?? []) as ConcreteSurfaceInput[];

  const breakdown = calculateQuoteBreakdown({
    zoneId: body.zoneId,
    selectedServices,
    selectedAddOns: body.selectedAddOns,
    surfaceArea: body.surfaceArea,
    applyBundles: body.applyBundles,
    depositRate: body.depositRate,
    serviceOverrides: sanitizedOverrides,
    concreteSurfaces
  });

  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const quoteValues: typeof quotes.$inferInsert = {
    contactId: body.contactId,
    propertyId: body.propertyId,
    status: "pending",
    services: selectedServices,
    addOns: body.selectedAddOns ?? null,
    surfaceArea: toOptionalPgNumeric(body.surfaceArea),
    zoneId: body.zoneId,
    travelFee: toPgNumeric(breakdown.travelFee),
    discounts: toPgNumeric(breakdown.discounts),
    addOnsTotal: toPgNumeric(breakdown.addOnsTotal),
    subtotal: toPgNumeric(breakdown.subtotal),
    total: toPgNumeric(breakdown.total),
    depositDue: toPgNumeric(breakdown.depositDue),
    depositRate: toPgNumeric(breakdown.depositRate),
    balanceDue: toPgNumeric(breakdown.balanceDue),
    lineItems: breakdown.lineItems,
    notes: body.notes ?? null,
    expiresAt
  };

  const [inserted] = await db.insert(quotes).values(quoteValues).returning();

  if (!inserted) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "quote.created",
    entityType: "quote",
    entityId: inserted.id,
    meta: {
      contactId: body.contactId,
      propertyId: body.propertyId,
      services: selectedServices,
      total: breakdown.total
    }
  });

  return NextResponse.json({
    ok: true,
    quote: {
      ...inserted,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
      sentAt: inserted.sentAt ? inserted.sentAt.toISOString() : null,
      expiresAt: inserted.expiresAt ? inserted.expiresAt.toISOString() : null
    },
    breakdown
  });
}

