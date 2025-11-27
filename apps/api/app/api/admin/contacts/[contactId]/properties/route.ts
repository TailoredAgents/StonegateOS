import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, contacts, properties } from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import { eq } from "drizzle-orm";
import { forwardGeocode } from "@/lib/geocode";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const {
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode
  } = payload as Record<string, unknown>;

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

  const db = getDb();

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const geo = await forwardGeocode({
    addressLine1: addressLine1.trim(),
    city: city.trim(),
    state: state.trim().slice(0, 2).toUpperCase(),
    postalCode: postalCode.trim()
  });

  const [property] = await db
    .insert(properties)
    .values({
      contactId,
      addressLine1: addressLine1.trim(),
      addressLine2:
        typeof addressLine2 === "string" && addressLine2.trim().length
          ? addressLine2.trim()
          : null,
      city: city.trim(),
      state: state.trim().slice(0, 2).toUpperCase(),
      postalCode: postalCode.trim(),
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null
    })
    .returning({
      id: properties.id,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      createdAt: properties.createdAt
    });

  if (!property) {
    return NextResponse.json({ error: "property_insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    property: {
      id: property.id,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      createdAt: property.createdAt.toISOString()
    }
  });
}
