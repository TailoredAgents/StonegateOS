import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, quotes, contacts, properties } from "@/db";
import { isAdminRequest } from "../../web/admin";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const [deleted] = await db.delete(quotes).where(eq(quotes.id, id)).returning({ id: quotes.id });
  if (!deleted?.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, quoteId: deleted.id });
}
