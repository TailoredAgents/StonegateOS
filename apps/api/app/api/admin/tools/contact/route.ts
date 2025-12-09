import { NextRequest, NextResponse } from "next/server";
import { getDb, contacts, properties, crmPipeline } from "@/db";
import { forwardGeocode } from "@/lib/geocode";
import { isAdminRequest } from "../../../web/admin";
import { normalizeName, normalizePhone } from "../../../web/utils";

type CreateContactPayload = {
  contactName?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source?: string;
};

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as CreateContactPayload | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const contactName = typeof payload.contactName === "string" ? payload.contactName.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
  const addressLine1 = typeof payload.addressLine1 === "string" ? payload.addressLine1.trim() : "";
  const addressLine2 = typeof payload.addressLine2 === "string" ? payload.addressLine2.trim() : "";
  const city = typeof payload.city === "string" ? payload.city.trim() : "";
  const state = typeof payload.state === "string" ? payload.state.trim() : "";
  const postalCode = typeof payload.postalCode === "string" ? payload.postalCode.trim() : "";

  if (!contactName.length) {
    return NextResponse.json({ error: "contact_name_required" }, { status: 400 });
  }
  if (!addressLine1.length) {
    return NextResponse.json({ error: "address_required" }, { status: 400 });
  }
  if (!city.length) {
    return NextResponse.json({ error: "city_required" }, { status: 400 });
  }
  if (!state.length) {
    return NextResponse.json({ error: "state_required" }, { status: 400 });
  }
  if (!postalCode.length) {
    return NextResponse.json({ error: "postal_code_required" }, { status: 400 });
  }

  const { firstName, lastName } = normalizeName(contactName);

  let normalizedPhone: { raw: string; e164: string } | null = null;
  if (phone.length) {
    try {
      normalizedPhone = normalizePhone(phone);
    } catch {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const geo = await forwardGeocode({
        addressLine1,
        city,
        state: state.slice(0, 2).toUpperCase(),
        postalCode
      });

      const [contact] = await tx
        .insert(contacts)
        .values({
          firstName,
          lastName,
          email: email.length ? email : null,
          phone: normalizedPhone?.raw ?? (phone.length ? phone : null),
          phoneE164: normalizedPhone?.e164 ?? null,
          preferredContactMethod: "phone",
          source: payload.source ?? "chat_tool"
        })
        .returning();

      if (!contact) {
        throw new Error("contact_insert_failed");
      }

      const [property] = await tx
        .insert(properties)
        .values({
          contactId: contact.id,
          addressLine1,
          addressLine2: addressLine2.length ? addressLine2 : null,
          city,
          state: state.slice(0, 2).toUpperCase(),
          postalCode,
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
    const summary = `${contact.firstName} ${contact.lastName} at ${addressLine1}, ${city}, ${state} ${postalCode}`;

    return NextResponse.json({
      ok: true,
      contactId: contact.id,
      propertyId: property?.id ?? null,
      summary,
      contact: {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        phoneE164: contact.phoneE164
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
    });
  } catch (error) {
    const message =
      error instanceof Error && typeof error.message === "string" ? error.message : "contact_create_failed";
    const status = message === "contact_insert_failed" ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
