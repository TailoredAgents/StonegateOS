import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, contacts, contactProperties, properties } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { eq } from "drizzle-orm";
import { forwardGeocode } from "@/lib/geocode";
import {
  getPostgresErrorMeta,
  isPropertyAddressConflict,
  normalizePropertyAddress,
} from "@/lib/property-write";
import type { InferInsertModel } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "properties.write");
  if (permissionError) return permissionError;

  const { contactId } = await context.params;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { addressLine1, addressLine2, city, state, postalCode } =
    payload as Record<string, unknown>;

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
    return NextResponse.json(
      { error: "postal_code_required" },
      { status: 400 },
    );
  }
  if (
    addressLine2 !== undefined &&
    addressLine2 !== null &&
    typeof addressLine2 !== "string"
  ) {
    return NextResponse.json(
      { error: "invalid_address_line2" },
      { status: 400 },
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const normalizedAddress = normalizePropertyAddress({
    addressLine1,
    addressLine2: typeof addressLine2 === "string" ? addressLine2 : null,
    city,
    state,
    postalCode,
  });
  const geo = await forwardGeocode(normalizedAddress);

  const insertPayload: InferInsertModel<typeof properties> = {
    contactId,
    addressKey: normalizedAddress.addressKey,
    addressLine1: normalizedAddress.addressLine1,
    addressLine2: normalizedAddress.addressLine2,
    city: normalizedAddress.city,
    state: normalizedAddress.state,
    postalCode: normalizedAddress.postalCode,
    lat:
      geo?.lat !== undefined && geo?.lat !== null ? geo.lat.toString() : null,
    lng:
      geo?.lng !== undefined && geo?.lng !== null ? geo.lng.toString() : null,
  };

  type PropertyResult =
    | {
        id: string;
        addressLine1: string;
        addressLine2: string | null;
        city: string;
        state: string;
        postalCode: string;
        createdAt: Date;
      }
    | undefined;

  let property: PropertyResult;
  let propertyCreated = false;
  let associationCreated = false;

  try {
    const result = await db.transaction(async (tx) => {
      const selection = {
        id: properties.id,
        addressLine1: properties.addressLine1,
        addressLine2: properties.addressLine2,
        city: properties.city,
        state: properties.state,
        postalCode: properties.postalCode,
        createdAt: properties.createdAt,
      } as const;

      let [resolvedProperty] = await tx
        .select(selection)
        .from(properties)
        .where(eq(properties.addressKey, normalizedAddress.addressKey))
        .limit(1);
      let created = false;

      if (!resolvedProperty) {
        [resolvedProperty] = await tx
          .insert(properties)
          .values(insertPayload)
          .onConflictDoNothing()
          .returning(selection);
        created = Boolean(resolvedProperty);
      }

      if (!resolvedProperty) {
        [resolvedProperty] = await tx
          .select(selection)
          .from(properties)
          .where(eq(properties.addressKey, normalizedAddress.addressKey))
          .limit(1);
      }

      if (!resolvedProperty) {
        throw new Error("property_resolve_failed");
      }

      const [association] = await tx
        .insert(contactProperties)
        .values({
          contactId,
          propertyId: resolvedProperty.id,
          relationship: "customer",
        })
        .onConflictDoNothing()
        .returning({ id: contactProperties.id });

      return {
        property: resolvedProperty,
        propertyCreated: created,
        associationCreated: Boolean(association),
      };
    });
    property = result.property;
    propertyCreated = result.propertyCreated;
    associationCreated = result.associationCreated;
  } catch (error) {
    const meta = getPostgresErrorMeta(error);
    if (isPropertyAddressConflict(error) || meta.code === "23505") {
      return NextResponse.json(
        {
          error: "property_already_exists",
          message:
            "This address belongs to another physical property and must be linked instead.",
        },
        { status: 409 },
      );
    }
    throw error;
  }

  if (!property) {
    return NextResponse.json(
      { error: "property_insert_failed" },
      { status: 500 },
    );
  }

  if (propertyCreated || associationCreated) {
    await recordAuditEvent({
      actor,
      action: propertyCreated ? "property.created" : "property.linked",
      entityType: "property",
      entityId: property.id,
      meta: { contactId, propertyCreated, associationCreated },
    });
  }

  return NextResponse.json({
    property: {
      id: property.id,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      createdAt: property.createdAt.toISOString(),
      shared: !propertyCreated,
      associationCreated,
    },
  });
}
