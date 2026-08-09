import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { contactProperties, getDb, properties } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { and, eq } from "drizzle-orm";
import { forwardGeocode } from "@/lib/geocode";
import {
  getPostgresErrorMeta,
  isPropertyAddressConflict,
  normalizePropertyAddress,
} from "@/lib/property-write";

type RouteContext = {
  params: Promise<{ contactId?: string; propertyId?: string }>;
};

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "properties.write");
  if (permissionError) return permissionError;

  const { contactId, propertyId } = await context.params;
  if (!contactId || !propertyId) {
    return NextResponse.json(
      { error: "contact_and_property_required" },
      { status: 400 },
    );
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { addressLine1, addressLine2, city, state, postalCode } =
    payload as Record<string, unknown>;

  const updates: {
    addressLine1?: string;
    addressLine2?: string | null;
    city?: string;
    state?: string;
    postalCode?: string;
  } = {};

  if (addressLine1 !== undefined) {
    if (typeof addressLine1 === "string" && addressLine1.trim().length > 0) {
      updates["addressLine1"] = addressLine1.trim();
    } else if (
      addressLine1 === null ||
      (typeof addressLine1 === "string" && addressLine1.trim().length === 0)
    ) {
      return NextResponse.json({ error: "address_required" }, { status: 400 });
    } else {
      return NextResponse.json({ error: "invalid_address" }, { status: 400 });
    }
  }

  if (addressLine2 !== undefined) {
    if (typeof addressLine2 === "string" && addressLine2.trim().length > 0) {
      updates["addressLine2"] = addressLine2.trim();
    } else if (
      addressLine2 === null ||
      (typeof addressLine2 === "string" && addressLine2.trim().length === 0)
    ) {
      updates["addressLine2"] = null;
    } else {
      return NextResponse.json(
        { error: "invalid_address_line2" },
        { status: 400 },
      );
    }
  }

  if (city !== undefined) {
    if (typeof city === "string" && city.trim().length > 0) {
      updates["city"] = city.trim();
    } else {
      return NextResponse.json({ error: "city_required" }, { status: 400 });
    }
  }

  if (state !== undefined) {
    if (typeof state === "string" && state.trim().length > 0) {
      updates["state"] = state.trim().slice(0, 2).toUpperCase();
    } else {
      return NextResponse.json({ error: "state_required" }, { status: 400 });
    }
  }

  if (postalCode !== undefined) {
    if (typeof postalCode === "string" && postalCode.trim().length > 0) {
      updates["postalCode"] = postalCode.trim();
    } else {
      return NextResponse.json(
        { error: "postal_code_required" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_updates_provided" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const addressChanged =
    updates.addressLine1 !== undefined ||
    updates.city !== undefined ||
    updates.state !== undefined ||
    updates.postalCode !== undefined;
  const addressIdentityChanged =
    addressChanged || updates.addressLine2 !== undefined;

  let updated: {
    id: string;
    contactId: string | null;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    lat: string | null;
    lng: string | null;
    updatedAt: Date;
  } | null;

  try {
    updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: properties.id,
          contactId: properties.contactId,
          addressKey: properties.addressKey,
          addressLine1: properties.addressLine1,
          addressLine2: properties.addressLine2,
          city: properties.city,
          state: properties.state,
          postalCode: properties.postalCode,
          lat: properties.lat,
          lng: properties.lng,
        })
        .from(properties)
        .where(eq(properties.id, propertyId))
        .limit(1)
        .for("update");

      if (!current) return null;

      if (current.contactId !== contactId) {
        const [association] = await tx
          .select({ id: contactProperties.id })
          .from(contactProperties)
          .where(
            and(
              eq(contactProperties.contactId, contactId),
              eq(contactProperties.propertyId, current.id),
            ),
          )
          .limit(1);
        if (!association) return null;
      }

      const persistedUpdates: typeof updates & {
        updatedAt: Date;
        addressKey?: string;
        lat?: string;
        lng?: string;
      } = {
        ...updates,
        updatedAt: new Date(),
      };

      const mergedAddress = {
        addressLine1: updates.addressLine1 ?? current.addressLine1,
        addressLine2:
          updates.addressLine2 !== undefined
            ? updates.addressLine2
            : current.addressLine2,
        city: updates.city ?? current.city,
        state: updates.state ?? current.state,
        postalCode: updates.postalCode ?? current.postalCode,
      };

      const normalizedAddress = normalizePropertyAddress(mergedAddress);

      if (addressIdentityChanged) {
        persistedUpdates.addressKey = normalizedAddress.addressKey;
      }

      if (addressChanged) {
        const geo = await forwardGeocode(normalizedAddress);

        // A provider outage or no-match result must not erase coordinates that
        // were previously confirmed for this property.
        if (geo) {
          persistedUpdates.lat = geo.lat.toString();
          persistedUpdates.lng = geo.lng.toString();
        }
      }

      const [row] = await tx
        .update(properties)
        .set(persistedUpdates)
        .where(eq(properties.id, current.id))
        .returning({
          id: properties.id,
          contactId: properties.contactId,
          addressLine1: properties.addressLine1,
          addressLine2: properties.addressLine2,
          city: properties.city,
          state: properties.state,
          postalCode: properties.postalCode,
          lat: properties.lat,
          lng: properties.lng,
          updatedAt: properties.updatedAt,
        });

      return row ?? null;
    });
  } catch (error) {
    const meta = getPostgresErrorMeta(error);
    if (isPropertyAddressConflict(error) || meta.code === "23505") {
      return NextResponse.json(
        {
          error: "property_already_exists",
          message:
            "A property with this street, state, and postal code already exists.",
        },
        { status: 409 },
      );
    }
    throw error;
  }

  if (!updated) {
    return NextResponse.json({ error: "property_not_found" }, { status: 404 });
  }

  const changedFields = Object.keys(updates).filter(
    (key) => key !== "updatedAt",
  );

  await recordAuditEvent({
    actor,
    action: "property.updated",
    entityType: "property",
    entityId: updated.id,
    meta: { contactId, fields: changedFields },
  });

  return NextResponse.json({
    property: {
      id: updated.id,
      addressLine1: updated.addressLine1,
      addressLine2: updated.addressLine2,
      city: updated.city,
      state: updated.state,
      postalCode: updated.postalCode,
      lat: updated.lat,
      lng: updated.lng,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "properties.delete");
  if (permissionError) return permissionError;

  const { contactId, propertyId } = await context.params;
  if (!contactId || !propertyId) {
    return NextResponse.json(
      { error: "contact_and_property_required" },
      { status: 400 },
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const result = await db.transaction(async (tx) => {
    const [property] = await tx
      .select({ id: properties.id, contactId: properties.contactId })
      .from(properties)
      .where(eq(properties.id, propertyId))
      .limit(1)
      .for("update");

    if (!property) return null;

    const [association] = await tx
      .select({ id: contactProperties.id })
      .from(contactProperties)
      .where(
        and(
          eq(contactProperties.contactId, contactId),
          eq(contactProperties.propertyId, propertyId),
        ),
      )
      .limit(1);

    if (!association && property.contactId !== contactId) return null;

    const removedAssociations = await tx
      .delete(contactProperties)
      .where(
        and(
          eq(contactProperties.contactId, contactId),
          eq(contactProperties.propertyId, propertyId),
        ),
      )
      .returning({ id: contactProperties.id });

    let compatibilityOwnerContactId = property.contactId;
    if (property.contactId === contactId) {
      const [remainingAssociation] = await tx
        .select({ contactId: contactProperties.contactId })
        .from(contactProperties)
        .where(eq(contactProperties.propertyId, propertyId))
        .limit(1);
      compatibilityOwnerContactId = remainingAssociation?.contactId ?? null;
      await tx
        .update(properties)
        .set({
          contactId: compatibilityOwnerContactId,
          updatedAt: new Date(),
        })
        .where(eq(properties.id, propertyId));
    }

    return {
      id: property.id,
      associationRemoved: removedAssociations.length > 0,
      compatibilityOwnerContactId,
    };
  });

  if (!result) {
    return NextResponse.json({ error: "property_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "property.unlinked",
    entityType: "property",
    entityId: result.id,
    meta: {
      contactId,
      associationRemoved: result.associationRemoved,
      compatibilityOwnerContactId: result.compatibilityOwnerContactId,
      physicalPropertyRetained: true,
    },
  });

  return NextResponse.json({
    deleted: true,
    unlinked: true,
    physicalPropertyRetained: true,
  });
}
