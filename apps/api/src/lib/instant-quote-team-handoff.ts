import { and, eq, isNull } from "drizzle-orm";
import {
  contactProperties,
  contacts,
  instantQuoteRelationshipBackfillAmbiguities,
  instantQuotes,
  leads,
  properties,
  type DatabaseClient,
} from "@/db";

type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;

export type InstantQuoteHandoffExecutor = DatabaseClient | TransactionExecutor;

export type InstantQuoteLoadSize = {
  kind:
    | "quarter_to_half"
    | "half_to_three_quarters"
    | "three_quarters_to_full"
    | "custom";
  customLoads: number | null;
};

export type InstantQuoteLeadSource =
  | { type: "google" }
  | { type: "facebook" }
  | null;

export type InstantQuoteTeamHandoff = {
  instantQuoteId: string;
  contactId: string;
  propertyId: string;
  leadId: string;
  attribution: {
    quoteSource: string;
    leadSource: string | null;
  };
  bookingPrefill: {
    appointmentType: "junk_removal";
    propertyId: string;
    priceRangeMinCents: number;
    priceRangeMaxCents: number;
    loadSize: InstantQuoteLoadSize;
    source: InstantQuoteLeadSource;
    notes: string;
  };
  fullQuotePrefill: {
    propertyId: string;
    serviceIds: string[];
    priceRangeMinCents: number;
    priceRangeMaxCents: number;
    notes: string;
  };
};

export type InstantQuoteHandoffFailureCode =
  | "instant_quote_not_found"
  | "instant_quote_relationship_missing"
  | "instant_quote_relationship_ambiguous"
  | "instant_quote_prefill_invalid";

export class InstantQuoteHandoffFailure extends Error {
  readonly code: InstantQuoteHandoffFailureCode;
  readonly status: 404 | 409;

  constructor(
    code: InstantQuoteHandoffFailureCode,
    message: string,
    status: 404 | 409,
  ) {
    super(message);
    this.name = "InstantQuoteHandoffFailure";
    this.code = code;
    this.status = status;
  }
}

type QuoteRecord = {
  id: string;
  contactId: string | null;
  propertyId: string | null;
  source: string;
  notes: string | null;
  jobTypes: string[];
  perceivedSize: string;
  aiResult: unknown;
};

type LeadRecord = {
  id: string;
  contactId: string;
  propertyId: string;
  source: string | null;
};

export type InstantQuoteHandoffSnapshot = {
  quote: QuoteRecord | null;
  relationshipBackfillAmbiguous: boolean;
  activeContactExists: boolean;
  propertyAssociationExists: boolean;
  leads: LeadRecord[];
};

type QuoteAiResult = {
  loadFractionEstimate: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  priceLowDiscounted: number | null;
  priceHighDiscounted: number | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseQuoteAiResult(value: unknown): QuoteAiResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      loadFractionEstimate: null,
      priceLow: null,
      priceHigh: null,
      priceLowDiscounted: null,
      priceHighDiscounted: null,
    };
  }
  const record = value as Record<string, unknown>;
  return {
    loadFractionEstimate: finiteNumber(record["loadFractionEstimate"]),
    priceLow: finiteNumber(record["priceLow"]),
    priceHigh: finiteNumber(record["priceHigh"]),
    priceLowDiscounted: finiteNumber(record["priceLowDiscounted"]),
    priceHighDiscounted: finiteNumber(record["priceHighDiscounted"]),
  };
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function priceDollarsToCents(value: number | null): number | null {
  if (value === null || value < 0) return null;
  return Math.round(value * 100);
}

function resolvePriceRange(ai: QuoteAiResult): {
  minCents: number;
  maxCents: number;
} {
  const low = priceDollarsToCents(ai.priceLowDiscounted ?? ai.priceLow);
  const high = priceDollarsToCents(ai.priceHighDiscounted ?? ai.priceHigh);
  if (low === null || high === null) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_prefill_invalid",
      "This instant quote does not contain a usable price range. Review it before booking.",
      409,
    );
  }
  return {
    minCents: Math.min(low, high),
    maxCents: Math.max(low, high),
  };
}

export function mapInstantQuoteLoadSize(input: {
  loadFractionEstimate: number | null;
  perceivedSize: string;
}): InstantQuoteLoadSize {
  const fraction = input.loadFractionEstimate;
  if (typeof fraction === "number" && Number.isFinite(fraction) && fraction > 0) {
    if (fraction <= 0.5) {
      return { kind: "quarter_to_half", customLoads: null };
    }
    if (fraction <= 0.75) {
      return { kind: "half_to_three_quarters", customLoads: null };
    }
    if (fraction <= 1) {
      return { kind: "three_quarters_to_full", customLoads: null };
    }
    return {
      kind: "custom",
      customLoads: Math.ceil(fraction * 4) / 4,
    };
  }

  const size = normalizeToken(input.perceivedSize);
  if (/full|large|big/u.test(size)) {
    return { kind: "three_quarters_to_full", customLoads: null };
  }
  if (/half|medium/u.test(size)) {
    return { kind: "half_to_three_quarters", customLoads: null };
  }
  return { kind: "quarter_to_half", customLoads: null };
}

export function mapInstantQuoteLeadSource(
  ...values: Array<string | null | undefined>
): InstantQuoteLeadSource {
  const normalized = values.map((value) => normalizeToken(value ?? ""));
  const facebookSources = new Set([
    "facebook",
    "facebook_ad",
    "facebook_ads",
    "facebook_lead",
    "facebook_messenger",
    "instagram",
    "instagram_ad",
    "instagram_ads",
    "messenger",
    "meta",
    "meta_ad",
    "meta_ads",
    "meta_messenger",
  ]);
  if (normalized.some((source) => facebookSources.has(source))) {
    return { type: "facebook" };
  }
  const googleSources = new Set([
    "google",
    "google_ad",
    "google_ads",
    "google_search",
  ]);
  if (normalized.some((source) => googleSources.has(source))) {
    return { type: "google" };
  }
  return null;
}

const FULL_QUOTE_SERVICE_MAP: Readonly<Record<string, string>> = {
  single_item: "single-item",
  furniture: "furniture",
  appliances: "appliances",
  appliance: "appliances",
  yard_waste: "yard-waste",
  brush: "yard-waste",
  construction_debris: "construction-debris",
  hot_tub: "hot-tub",
  hot_tub_playset: "hot-tub",
  other: "other",
};

export function mapInstantQuoteServices(jobTypes: readonly string[]): string[] {
  return Array.from(
    new Set(
      jobTypes.flatMap((jobType) => {
        const mapped = FULL_QUOTE_SERVICE_MAP[normalizeToken(jobType)];
        return mapped ? [mapped] : [];
      }),
    ),
  );
}

function compactText(value: string | null | undefined, maxLength: number): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function centsLabel(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value / 100);
}

export function buildInstantQuoteHandoffNotes(input: {
  instantQuoteId: string;
  quoteSource: string;
  leadSource: string | null;
  jobTypes: readonly string[];
  customerNotes: string | null;
  minCents: number;
  maxCents: number;
  loadSize: InstantQuoteLoadSize;
}): string {
  const quoteSource = compactText(input.quoteSource, 80) || "unknown source";
  const leadSource = compactText(input.leadSource, 80);
  const requestedWork = input.jobTypes
    .map((value) => compactText(value, 80))
    .filter(Boolean)
    .join(", ");
  const customerNotes = compactText(input.customerNotes, 2_000);
  const loadLabel =
    input.loadSize.kind === "custom" && input.loadSize.customLoads
      ? `${input.loadSize.customLoads} trailer loads`
      : input.loadSize.kind.replace(/_/gu, " ");
  return [
    `Instant quote ${input.instantQuoteId}`,
    `Attribution: ${quoteSource}${leadSource && leadSource !== quoteSource ? ` / ${leadSource}` : ""}`,
    `Quoted range: ${centsLabel(input.minCents)}–${centsLabel(input.maxCents)}`,
    `Estimated load: ${loadLabel}`,
    requestedWork ? `Requested work: ${requestedWork}` : null,
    customerNotes ? `Customer notes: ${customerNotes}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 2_000);
}

export function resolveInstantQuoteTeamHandoff(
  snapshot: InstantQuoteHandoffSnapshot,
): InstantQuoteTeamHandoff {
  const quote = snapshot.quote;
  if (!quote) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_not_found",
      "The instant quote could not be found.",
      404,
    );
  }
  if (snapshot.relationshipBackfillAmbiguous) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_relationship_ambiguous",
      "This historical quote has more than one possible customer or property. Resolve the relationship before continuing.",
      409,
    );
  }
  if (
    !quote.contactId ||
    !quote.propertyId ||
    !snapshot.activeContactExists ||
    !snapshot.propertyAssociationExists
  ) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_relationship_missing",
      "This quote is not linked to one active customer and property. Repair the relationship before continuing.",
      409,
    );
  }
  if (snapshot.leads.length > 1) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_relationship_ambiguous",
      "This quote is linked to more than one lead. Resolve the duplicate relationship before continuing.",
      409,
    );
  }
  const lead = snapshot.leads[0];
  if (
    !lead ||
    lead.contactId !== quote.contactId ||
    lead.propertyId !== quote.propertyId
  ) {
    throw new InstantQuoteHandoffFailure(
      "instant_quote_relationship_missing",
      "The quote and its lead do not share the same customer and property. Repair the relationship before continuing.",
      409,
    );
  }

  const ai = parseQuoteAiResult(quote.aiResult);
  const range = resolvePriceRange(ai);
  const loadSize = mapInstantQuoteLoadSize({
    loadFractionEstimate: ai.loadFractionEstimate,
    perceivedSize: quote.perceivedSize,
  });
  const source = mapInstantQuoteLeadSource(lead.source, quote.source);
  const notes = buildInstantQuoteHandoffNotes({
    instantQuoteId: quote.id,
    quoteSource: quote.source,
    leadSource: lead.source,
    jobTypes: quote.jobTypes,
    customerNotes: quote.notes,
    minCents: range.minCents,
    maxCents: range.maxCents,
    loadSize,
  });

  return {
    instantQuoteId: quote.id,
    contactId: quote.contactId,
    propertyId: quote.propertyId,
    leadId: lead.id,
    attribution: {
      quoteSource: quote.source,
      leadSource: lead.source,
    },
    bookingPrefill: {
      appointmentType: "junk_removal",
      propertyId: quote.propertyId,
      priceRangeMinCents: range.minCents,
      priceRangeMaxCents: range.maxCents,
      loadSize,
      source,
      notes,
    },
    fullQuotePrefill: {
      propertyId: quote.propertyId,
      serviceIds: mapInstantQuoteServices(quote.jobTypes),
      priceRangeMinCents: range.minCents,
      priceRangeMaxCents: range.maxCents,
      notes,
    },
  };
}

export async function loadInstantQuoteHandoffSnapshot(
  db: InstantQuoteHandoffExecutor,
  instantQuoteId: string,
): Promise<InstantQuoteHandoffSnapshot> {
  const [quote] = await db
    .select({
      id: instantQuotes.id,
      contactId: instantQuotes.contactId,
      propertyId: instantQuotes.propertyId,
      source: instantQuotes.source,
      notes: instantQuotes.notes,
      jobTypes: instantQuotes.jobTypes,
      perceivedSize: instantQuotes.perceivedSize,
      aiResult: instantQuotes.aiResult,
    })
    .from(instantQuotes)
    .where(eq(instantQuotes.id, instantQuoteId))
    .limit(1);
  if (!quote) {
    return {
      quote: null,
      relationshipBackfillAmbiguous: false,
      activeContactExists: false,
      propertyAssociationExists: false,
      leads: [],
    };
  }

  const ambiguity = await db
    .select({ id: instantQuoteRelationshipBackfillAmbiguities.instantQuoteId })
    .from(instantQuoteRelationshipBackfillAmbiguities)
    .where(
      eq(
        instantQuoteRelationshipBackfillAmbiguities.instantQuoteId,
        instantQuoteId,
      ),
    )
    .limit(1);
  const activeContact = quote.contactId
    ? await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(eq(contacts.id, quote.contactId), isNull(contacts.deletedAt)),
        )
        .limit(1)
    : [];
  const propertyAssociation =
    quote.contactId && quote.propertyId
      ? await db
          .select({ id: contactProperties.id })
          .from(contactProperties)
          .innerJoin(
            properties,
            eq(properties.id, contactProperties.propertyId),
          )
          .where(
            and(
              eq(contactProperties.contactId, quote.contactId),
              eq(contactProperties.propertyId, quote.propertyId),
            ),
          )
          .limit(1)
      : [];
  const relatedLeads = await db
    .select({
      id: leads.id,
      contactId: leads.contactId,
      propertyId: leads.propertyId,
      source: leads.source,
    })
    .from(leads)
    .where(eq(leads.instantQuoteId, instantQuoteId))
    .limit(2);

  return {
    quote,
    relationshipBackfillAmbiguous: Boolean(ambiguity[0]),
    activeContactExists: Boolean(activeContact[0]),
    propertyAssociationExists: Boolean(propertyAssociation[0]),
    leads: relatedLeads,
  };
}

export async function loadInstantQuoteTeamHandoff(
  db: InstantQuoteHandoffExecutor,
  instantQuoteId: string,
): Promise<InstantQuoteTeamHandoff> {
  return resolveInstantQuoteTeamHandoff(
    await loadInstantQuoteHandoffSnapshot(db, instantQuoteId),
  );
}
