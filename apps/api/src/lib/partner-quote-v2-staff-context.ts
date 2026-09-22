import {
  formatPartnerServiceRate,
  PartnerServiceRateSchema,
} from "@myst-os/pricing";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  contactProperties,
  contacts,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookings,
  partnerBookingServiceLines,
  properties,
} from "@/db";

export type PartnerCommercialLineSeed = Readonly<{
  id: string;
  serviceKey: string;
  title: string;
  description: string;
  amountCents: number | null;
  rateReferences: string[];
}>;

export function partnerServiceCommercialSeed(
  line: Pick<
    typeof partnerBookingServiceLines.$inferSelect,
    | "id"
    | "serviceKey"
    | "serviceLabel"
    | "description"
    | "priceDescription"
    | "quotedAmountCents"
    | "pricingSnapshot"
    | "rateSnapshot"
  >,
  priced: boolean,
): PartnerCommercialLineSeed {
  const snapshot = line.pricingSnapshot ?? line.rateSnapshot;
  const currency = snapshot?.["currency"];
  const rates = snapshot?.["rates"];
  const rateReferences =
    typeof currency === "string" &&
    /^[A-Z]{3}$/.test(currency) &&
    Array.isArray(rates)
      ? rates.map((rate) => {
          const parsed = PartnerServiceRateSchema.safeParse(rate);
          if (!parsed.success || parsed.data.serviceKey !== line.serviceKey)
            throw new Error("partner_commercial_rate_invalid");
          return `${parsed.data.label}: ${formatPartnerServiceRate(parsed.data, currency)} — ${parsed.data.measurement}`;
        })
      : [];
  return {
    id: line.id,
    serviceKey: line.serviceKey,
    title: line.serviceLabel,
    description:
      line.priceDescription &&
      line.priceDescription.trim() !== line.description.trim()
        ? `${line.description}\n\nReviewed work: ${line.priceDescription}`
        : line.description,
    amountCents: priced ? line.quotedAmountCents : null,
    rateReferences,
  };
}

export type PartnerQuoteV2StaffContext = Readonly<{
  account: Readonly<{ id: string; name: string }>;
  targets: readonly Readonly<{
    type: "location" | "booking";
    id: string;
    label: string;
    address: string;
    propertyId: string;
    contactId: string;
    contactName: string;
    contactEmail: string | null;
    serviceLines: readonly PartnerCommercialLineSeed[];
  }>[];
  truncated: boolean;
}>;

/**
 * Staff may bind a new Quote V2 draft only through an explicit account-owned
 * CRM contact + physical property + either an active Partner location or one
 * exact nonterminal Partner job. Ambiguous contact/property relationships
 * remain separate choices; no array-order default can silently bind a quote.
 */
export async function loadPartnerQuoteV2StaffContext(input: {
  accountId: string;
  limit?: number;
}): Promise<PartnerQuoteV2StaffContext | null> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const db = getDb();
  const [account] = await db
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
    })
    .from(partnerAccounts)
    .where(
      and(
        eq(partnerAccounts.id, input.accountId),
        inArray(partnerAccounts.status, [
          "active_partner",
          "portal_partner",
          "managed_partner",
        ]),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .limit(1);
  if (!account) return null;

  const locationRows = await db
    .select({
      locationId: partnerAccountLocations.id,
      siteName: partnerAccountLocations.siteName,
      addressLine1: partnerAccountLocations.addressLine1,
      addressLine2: partnerAccountLocations.addressLine2,
      city: partnerAccountLocations.city,
      state: partnerAccountLocations.state,
      postalCode: partnerAccountLocations.postalCode,
      propertyId: properties.id,
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
    })
    .from(partnerAccountLocations)
    .innerJoin(
      properties,
      eq(properties.id, partnerAccountLocations.propertyId),
    )
    .innerJoin(
      contactProperties,
      eq(contactProperties.propertyId, properties.id),
    )
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, contactProperties.contactId),
        eq(contacts.partnerAccountId, partnerAccountLocations.partnerAccountId),
        isNull(contacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, input.accountId),
        eq(partnerAccountLocations.active, true),
      ),
    )
    .orderBy(
      asc(partnerAccountLocations.siteName),
      asc(contacts.lastName),
      asc(contacts.firstName),
      asc(contacts.id),
    )
    .limit(limit + 1);

  const bookingRows = await db
    .select({
      bookingId: partnerBookings.id,
      serviceKey: partnerBookings.serviceKey,
      modelVersion: partnerBookings.modelVersion,
      pricedAt: partnerBookings.pricedAt,
      scopeSnapshot: partnerBookings.scopeSnapshot,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      propertyId: properties.id,
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
    })
    .from(partnerBookings)
    .innerJoin(properties, eq(properties.id, partnerBookings.propertyId))
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, partnerBookings.orgContactId),
        eq(contacts.partnerAccountId, partnerBookings.partnerAccountId),
        isNull(contacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(partnerBookings.partnerAccountId, input.accountId),
        notInArray(partnerBookings.publicStatus, [
          "completed",
          "canceled",
          "declined",
        ]),
      ),
    )
    .orderBy(desc(partnerBookings.updatedAt), desc(partnerBookings.id))
    .limit(limit + 1);

  const combinedIds = bookingRows
    .filter((row) => row.modelVersion === 2)
    .map((row) => row.bookingId);
  const serviceLines = combinedIds.length
    ? await db
        .select()
        .from(partnerBookingServiceLines)
        .where(
          and(
            eq(partnerBookingServiceLines.partnerAccountId, input.accountId),
            inArray(partnerBookingServiceLines.partnerBookingId, combinedIds),
          ),
        )
        .orderBy(asc(partnerBookingServiceLines.position))
    : [];

  const targets = [
    ...bookingRows.map((row) =>
      Object.freeze({
        type: "booking" as const,
        serviceLines: serviceLines
          .filter((line) => line.partnerBookingId === row.bookingId)
          .map((line) =>
            partnerServiceCommercialSeed(line, Boolean(row.pricedAt)),
          ),
        id: row.bookingId,
        label: `Partner job · ${typeof row.scopeSnapshot?.["serviceLabel"] === "string" ? row.scopeSnapshot["serviceLabel"] : row.serviceKey || "Service review"}`,
        address: [
          [row.addressLine1, row.addressLine2].filter(Boolean).join(" "),
          row.city,
          row.state,
          row.postalCode,
        ]
          .filter(Boolean)
          .join(", "),
        propertyId: row.propertyId,
        contactId: row.contactId,
        contactName:
          [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
          "Unnamed contact",
        contactEmail: row.email,
      }),
    ),
    ...locationRows.map((row) =>
      Object.freeze({
        type: "location" as const,
        serviceLines: [],
        id: row.locationId,
        label: row.siteName,
        address: [
          [row.addressLine1, row.addressLine2].filter(Boolean).join(" "),
          row.city,
          row.state,
          row.postalCode,
        ]
          .filter(Boolean)
          .join(", "),
        propertyId: row.propertyId,
        contactId: row.contactId,
        contactName:
          [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
          "Unnamed contact",
        contactEmail: row.email,
      }),
    ),
  ];

  return Object.freeze({
    account: Object.freeze(account),
    targets: Object.freeze(targets.slice(0, limit)),
    truncated: targets.length > limit,
  });
}
