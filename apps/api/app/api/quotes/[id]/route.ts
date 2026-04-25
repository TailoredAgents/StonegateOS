import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type { ConcreteSurfaceInput, ServiceCategory } from "@myst-os/pricing/src/types";
import { getDb, quotes, contacts, properties } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import { eq } from "drizzle-orm";

const SERVICE_ID_SET = new Set<ServiceCategory>(serviceRates.map((rate) => rate.service));

const serviceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value): value is ServiceCategory => SERVICE_ID_SET.has(value as ServiceCategory),
    "invalid_service"
  );

const UpdateQuoteSchema = z.object({
  zoneId: z.string().min(1),
  selectedServices: z.array(serviceIdSchema).min(1),
  selectedAddOns: z.array(z.string().min(1)).optional(),
  surfaceArea: z.number().positive().optional(),
  applyBundles: z.boolean().optional(),
  depositRate: z.number().positive().max(1).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  notes: z.string().max(2000).nullable().optional(),
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      surfaceArea: quotes.surfaceArea,
      zoneId: quotes.zoneId,
      travelFee: quotes.travelFee,
      discounts: quotes.discounts,
      addOnsTotal: quotes.addOnsTotal,
      subtotal: quotes.subtotal,
      total: quotes.total,
      depositDue: quotes.depositDue,
      depositRate: quotes.depositRate,
      balanceDue: quotes.balanceDue,
      lineItems: quotes.lineItems,
      notes: quotes.notes,
      shareToken: quotes.shareToken,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      contactName: contacts.firstName,
      contactEmail: contacts.email,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.id, id))
    .limit(1);

  const quote = rows[0];
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    quote: {
      id: quote.id,
      status: quote.status,
      services: quote.services,
      addOns: quote.addOns,
      surfaceArea: quote.surfaceArea,
      zoneId: quote.zoneId,
      travelFee: Number(quote.travelFee),
      discounts: Number(quote.discounts),
      addOnsTotal: Number(quote.addOnsTotal),
      subtotal: Number(quote.subtotal),
      total: Number(quote.total),
      depositDue: Number(quote.depositDue),
      depositRate: Number(quote.depositRate),
      balanceDue: Number(quote.balanceDue),
      lineItems: quote.lineItems,
      notes: quote.notes,
      shareToken: quote.shareToken,
      sentAt: quote.sentAt ? quote.sentAt.toISOString() : null,
      expiresAt: quote.expiresAt ? quote.expiresAt.toISOString() : null,
      decisionAt: quote.decisionAt ? quote.decisionAt.toISOString() : null,
      decisionNotes: quote.decisionNotes,
      createdAt: quote.createdAt.toISOString(),
      updatedAt: quote.updatedAt.toISOString(),
      contact: {
        name: quote.contactName,
        email: quote.contactEmail
      },
      property: {
        addressLine1: quote.propertyAddressLine1,
        city: quote.propertyCity,
        state: quote.propertyState,
        postalCode: quote.propertyPostalCode
      }
    }
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.update");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const parsedBody = UpdateQuoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsedBody.data;
  const db = getDb();
  const [existing] = await db
    .select({
      id: quotes.id,
      status: quotes.status
    })
    .from(quotes)
    .where(eq(quotes.id, id))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (existing.status === "accepted" || existing.status === "declined") {
    return NextResponse.json(
      { error: "quote_finalized", message: "Accepted or declined quotes cannot be edited." },
      { status: 400 }
    );
  }

  const selectedServices = body.selectedServices;
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
    : undefined;

  const [updated] = await db
    .update(quotes)
    .set({
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
      ...(expiresAt ? { expiresAt } : {}),
      updatedAt: new Date()
    })
    .where(eq(quotes.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "quote.updated",
    entityType: "quote",
    entityId: updated.id,
    meta: {
      services: selectedServices,
      total: breakdown.total
    }
  });

  return NextResponse.json({
    ok: true,
    quote: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      sentAt: updated.sentAt ? updated.sentAt.toISOString() : null,
      expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      decisionAt: updated.decisionAt ? updated.decisionAt.toISOString() : null
    },
    breakdown
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.delete");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const [deleted] = await db.delete(quotes).where(eq(quotes.id, id)).returning({ id: quotes.id });
  if (!deleted?.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "quote.deleted",
    entityType: "quote",
    entityId: deleted.id
  });

  return NextResponse.json({ ok: true, quoteId: deleted.id });
}
