import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  contactProperties,
  properties,
  type DatabaseClient,
} from "@/db";

export const LEGACY_PROPERTY_ADDRESS_UNIQUE_CONSTRAINT =
  "properties_address_key" as const;
export const PROPERTY_ADDRESS_UNIQUE_CONSTRAINT =
  "properties_physical_address_key" as const;

export type NormalizedPropertyAddress = {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  addressKey: string;
};

type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;

export type PropertyWriteExecutor = DatabaseClient | TransactionExecutor;
export type PropertyRecord = typeof properties.$inferSelect;

export type ResolveContactPropertyInput = {
  contactId: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  gated?: boolean;
  lat?: string | null;
  lng?: string | null;
  relationship?: string;
  now?: Date;
};

export type ResolveContactPropertyResult = {
  property: PropertyRecord;
  propertyCreated: boolean;
  associationCreated: boolean;
};

export type ContactPropertyLink = {
  contactId: string;
  property: PropertyRecord;
  source: "association" | "compatibility";
};

/**
 * Merges trusted association rows before rollback-only compatibility rows.
 * The contact allow-list is enforced again in memory so an accidental broad
 * compatibility query cannot leak another customer's physical property.
 */
export function mergeAssociationFirstContactPropertyRows(
  associated: ContactPropertyLink[],
  compatibility: ContactPropertyLink[],
  allowedContactIds: readonly string[],
): ContactPropertyLink[] {
  const allowed = new Set(allowedContactIds);
  const deduplicated = new Map<string, ContactPropertyLink>();
  const explicitlyAssociatedPropertyIds = new Set(
    associated.map((row) => row.property.id),
  );

  for (const row of associated) {
    if (!allowed.has(row.contactId)) continue;
    deduplicated.set(`${row.contactId}:${row.property.id}`, row);
  }
  for (const row of compatibility) {
    if (!allowed.has(row.contactId)) continue;
    if (explicitlyAssociatedPropertyIds.has(row.property.id)) continue;
    const key = `${row.contactId}:${row.property.id}`;
    if (!deduplicated.has(key)) deduplicated.set(key, row);
  }

  return Array.from(deduplicated.values()).sort(
    (left, right) =>
      right.property.createdAt.getTime() - left.property.createdAt.getTime(),
  );
}

/**
 * Loads explicit links first, then legacy-owner rows only when the physical
 * property has no association at all. A stale compatibility owner can never
 * override or broaden an explicit association.
 */
export async function loadContactPropertiesForContacts(
  db: PropertyWriteExecutor,
  contactIds: readonly string[],
  options: { limit?: number } = {},
): Promise<ContactPropertyLink[]> {
  const uniqueContactIds = Array.from(
    new Set(contactIds.filter((contactId) => contactId.length > 0)),
  );
  if (uniqueContactIds.length === 0) return [];
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 2_000), 1), 5_000);

  const associated = await db
    .select({
      contactId: contactProperties.contactId,
      property: properties,
    })
    .from(contactProperties)
    .innerJoin(properties, eq(contactProperties.propertyId, properties.id))
    .where(inArray(contactProperties.contactId, uniqueContactIds))
    .orderBy(desc(properties.createdAt))
    .limit(limit);

  const compatibilityRows = await db
    .select({
      contactId: properties.contactId,
      property: properties,
    })
    .from(properties)
    .leftJoin(
      contactProperties,
      eq(contactProperties.propertyId, properties.id),
    )
    .where(
      and(
        inArray(properties.contactId, uniqueContactIds),
        isNull(contactProperties.id),
      ),
    )
    .orderBy(desc(properties.createdAt))
    .limit(limit);

  const compatibility: ContactPropertyLink[] = compatibilityRows.flatMap(
    (row) =>
      row.contactId
        ? [
            {
              contactId: row.contactId,
              property: row.property,
              source: "compatibility" as const,
            },
          ]
        : [],
  );

  return mergeAssociationFirstContactPropertyRows(
    associated.map((row) => ({ ...row, source: "association" as const })),
    compatibility,
    uniqueContactIds,
  );
}

export async function loadContactPropertyById(
  db: PropertyWriteExecutor,
  input: { contactId: string; propertyId: string },
): Promise<PropertyRecord | null> {
  const [associated] = await db
    .select({ property: properties })
    .from(contactProperties)
    .innerJoin(properties, eq(contactProperties.propertyId, properties.id))
    .where(
      and(
        eq(contactProperties.contactId, input.contactId),
        eq(contactProperties.propertyId, input.propertyId),
      ),
    )
    .limit(1);
  if (associated?.property) return associated.property;

  const [compatibility] = await db
    .select({ property: properties })
    .from(properties)
    .leftJoin(
      contactProperties,
      eq(contactProperties.propertyId, properties.id),
    )
    .where(
      and(
        eq(properties.id, input.propertyId),
        eq(properties.contactId, input.contactId),
        isNull(contactProperties.id),
      ),
    )
    .limit(1);

  return compatibility?.property ?? null;
}

export async function ensureContactPropertyAssociation(
  db: PropertyWriteExecutor,
  input: {
    contactId: string;
    propertyId: string;
    relationship?: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [association] = await db
    .insert(contactProperties)
    .values({
      contactId: input.contactId,
      propertyId: input.propertyId,
      relationship: input.relationship ?? "customer",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: contactProperties.id });

  return Boolean(association);
}

/** Returns the newest property available through the new association or the
 * transitional compatibility owner. */
export async function findLatestContactProperty(
  db: PropertyWriteExecutor,
  contactId: string,
): Promise<PropertyRecord | null> {
  const [link] = await loadContactPropertiesForContacts(db, [contactId], {
    limit: 100,
  });
  return link?.property ?? null;
}

function normalizeIdentityPart(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function normalizePropertyAddress(input: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
}): NormalizedPropertyAddress {
  const addressLine1 = input.addressLine1.trim().replace(/\s+/gu, " ");
  const addressLine2Value = input.addressLine2?.trim().replace(/\s+/gu, " ");
  const addressLine2 = addressLine2Value ? addressLine2Value : null;
  const city = input.city.trim().replace(/\s+/gu, " ");
  const state = input.state.trim().slice(0, 2).toUpperCase();
  const postalCode = input.postalCode.trim().replace(/\s+/gu, "");

  return {
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    addressKey: [
      normalizeIdentityPart(addressLine1),
      normalizeIdentityPart(addressLine2 ?? ""),
      normalizeIdentityPart(city),
      normalizeIdentityPart(state),
      normalizeIdentityPart(postalCode).replace(/\s+/gu, ""),
    ].join("|"),
  };
}

/**
 * Resolves one canonical physical-address row and links it to the contact.
 *
 * `properties.contact_id` is written only as a compatibility owner for a new
 * row. Existing rows are never reassigned: `contact_properties` is the source
 * of truth and permits multiple customers at the same physical address.
 */
export async function resolveOrCreateContactProperty(
  db: PropertyWriteExecutor,
  input: ResolveContactPropertyInput,
): Promise<ResolveContactPropertyResult> {
  const normalized = normalizePropertyAddress(input);
  const now = input.now ?? new Date();

  let [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.addressKey, normalized.addressKey))
    .limit(1);
  let propertyCreated = false;

  if (!property) {
    [property] = await db
      .insert(properties)
      .values({
        contactId: input.contactId,
        addressKey: normalized.addressKey,
        addressLine1: normalized.addressLine1,
        addressLine2: normalized.addressLine2,
        city: normalized.city,
        state: normalized.state,
        postalCode: normalized.postalCode,
        gated: input.gated ?? false,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        createdAt: now,
        updatedAt: now,
      })
      // Catch-all conflict handling is intentional: address_key is protected
      // by a partial unique index, so a target-less clause is the portable
      // Drizzle representation for concurrent canonical writes.
      .onConflictDoNothing()
      .returning();
    propertyCreated = Boolean(property);
  }

  if (!property) {
    [property] = await db
      .select()
      .from(properties)
      .where(eq(properties.addressKey, normalized.addressKey))
      .limit(1);
  }

  if (!property) {
    throw new Error("property_resolve_failed");
  }

  const associationCreated = await ensureContactPropertyAssociation(db, {
    contactId: input.contactId,
    propertyId: property.id,
    relationship: input.relationship,
    now,
  });

  return {
    property,
    propertyCreated,
    associationCreated,
  };
}

type PostgresErrorMeta = {
  code?: string;
  constraint?: string;
  message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPostgresErrorMeta(value: unknown): PostgresErrorMeta {
  if (!isRecord(value)) return {};

  return {
    code: typeof value["code"] === "string" ? value["code"] : undefined,
    constraint:
      typeof value["constraint_name"] === "string"
        ? value["constraint_name"]
        : typeof value["constraint"] === "string"
          ? value["constraint"]
          : undefined,
    message:
      typeof value["message"] === "string" ? value["message"] : undefined,
  };
}

export function getPostgresErrorMeta(error: unknown): PostgresErrorMeta {
  const direct = readPostgresErrorMeta(error);
  const cause = isRecord(error) ? error["cause"] : null;
  const nested = readPostgresErrorMeta(cause);
  return {
    code: direct.code ?? nested.code,
    constraint: direct.constraint ?? nested.constraint,
    message: nested.message ?? direct.message,
  };
}

export function isPropertyAddressConflict(error: unknown): boolean {
  const meta = getPostgresErrorMeta(error);
  if (meta.code !== "23505") return false;

  return (
    meta.constraint === PROPERTY_ADDRESS_UNIQUE_CONSTRAINT ||
    meta.constraint === LEGACY_PROPERTY_ADDRESS_UNIQUE_CONSTRAINT ||
    meta.message?.includes(PROPERTY_ADDRESS_UNIQUE_CONSTRAINT) === true ||
    meta.message?.includes(LEGACY_PROPERTY_ADDRESS_UNIQUE_CONSTRAINT) === true
  );
}
