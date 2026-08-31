import { createHash, createHmac } from "node:crypto";
import {
  canonicalQuoteJson,
  hashQuoteContent,
  type QuoteAggregateState,
  type QuoteVersionState,
} from "@/lib/quote-v2-domain";

export const QUOTE_V2_LEGACY_BACKFILL_JOB = "quote-v2-legacy-import-v1";
export const QUOTE_V2_LEGACY_BACKFILL_CHECKPOINT = "quotes-by-created-at";
export const QUOTE_V2_LEGACY_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1_000;
const LEGACY_READ_DAYS = 90;
const LEGACY_ACCEPTED_READ_DAYS = 365;
const MAX_BATCH_SIZE = 500;
const PG_INTEGER_MAX = 2_147_483_647;

export type LegacyQuoteStatus = "pending" | "sent" | "accepted" | "declined";

export type LegacyQuoteBackfillCursor = {
  createdAt: string;
  id: string;
};

export type LegacyQuoteLeadCandidate = {
  id: string;
  contactId: string;
  propertyId: string;
};

export type LegacyQuoteBackfillRow = {
  id: string;
  contactId: string;
  propertyId: string;
  status: LegacyQuoteStatus;
  services: unknown;
  addOns: unknown;
  surfaceArea: unknown;
  zoneId: string;
  travelFee: unknown;
  discounts: unknown;
  addOnsTotal: unknown;
  subtotal: unknown;
  total: unknown;
  depositDue: unknown;
  depositRate: unknown;
  balanceDue: unknown;
  lineItems: unknown;
  availability: unknown;
  marketing: unknown;
  notes: string | null;
  quoteNumber: string | null;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  shareToken: string | null;
  sentAt: Date | null;
  expiresAt: Date | null;
  viewedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  decisionAt: Date | null;
  decisionNotes: string | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contact: {
    firstName: string;
    lastName: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    phoneE164: string | null;
    salespersonMemberId: string | null;
    deletedAt: Date | null;
  };
  property: {
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    legacyContactId: string | null;
  };
  linkedLeadCandidates: LegacyQuoteLeadCandidate[];
  hasCanonicalContactPropertyLink: boolean;
  ownerTeamMemberExists: boolean;
  quoteNumberCollision: boolean;
  activeHoldCount: number;
  acceptedAppointmentReferenceCount: number;
};

export type QuoteMigrationReviewReason =
  | "ambiguous_capability_recipient"
  | "ambiguous_lead_association"
  | "ambiguous_property_association"
  | "capability_hash_collision"
  | "duplicate_accepted_appointment_reference"
  | "duplicate_active_hold"
  | "duplicate_add_on_identifier"
  | "duplicate_lead_association"
  | "duplicate_line_item_key"
  | "duplicate_service_identifier"
  | "invalid_deposit_equation"
  | "invalid_expiry"
  | "invalid_financial_value"
  | "invalid_line_item"
  | "invalid_line_items_shape"
  | "invalid_owner_reference"
  | "invalid_total_equation"
  | "invalid_zero_total"
  | "legacy_state_not_issueable"
  | "quote_number_collision"
  | "quote_number_missing"
  | "version_number_collision";

export type QuoteMigrationReview = {
  reasonCode: QuoteMigrationReviewReason;
  details: Record<string, unknown>;
};

export type PreparedLegacyLineItem = {
  id: string;
  quoteVersionId: string;
  lineKey: string;
  catalogKey: string | null;
  name: string;
  description: string | null;
  quantity: string;
  unit: string;
  unitPriceMinCents: number;
  unitPriceMaxCents: number;
  amountMinCents: number;
  amountMaxCents: number;
  optionGroupId: null;
  selectedByDefault: false;
  displayOrder: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type PreparedLegacyAdjustment = {
  id: string;
  quoteVersionId: string;
  adjustmentKey: string;
  kind: "discount";
  label: string;
  calculation: "fixed";
  basis: "subtotal";
  eligibleLineItemKeys: string[];
  amountCents: number;
  basisPoints: null;
  amountMinCents: number;
  amountMaxCents: number;
  displayOrder: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type PreparedLegacyCapability = {
  id: string;
  quoteId: string;
  quoteVersionId: string;
  recipientRole: "signer";
  recipientAddressHash: string;
  allowedActions: string[];
  tokenHash: string;
  status: "active" | "revoked";
  readExpiresAt: Date;
  actionExpiresAt: Date | null;
  issuedAt: Date;
  revokedAt: Date | null;
  revocationReason: "contact_inactive" | null;
  useCount: 0;
  createdAt: Date;
  updatedAt: Date;
};

export type PreparedLegacyQuoteBackfill = {
  quoteId: string;
  cursor: LegacyQuoteBackfillCursor;
  opportunity: {
    id: string;
    contactId: string;
    propertyId: string;
    leadId: string | null;
    ownerTeamMemberId: string | null;
    name: string;
    status: "open" | "approved" | "lost";
    pipelineStage: "quoted";
    currency: "USD";
    estimatedValueCents: number;
    revision: number;
    closedAt: Date | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  };
  version: {
    id: string;
    quoteId: string;
    versionNumber: 1;
    draftRevision: number;
    supersedesVersionId: null;
    initialState: "draft";
    targetState: QuoteVersionState;
    provenance: "legacy_current_state";
    schemaVersion: number;
    documentType: "fixed_quote";
    audience: "residential" | "commercial";
    schedulingMode: "self_schedule";
    currency: "USD";
    documentSnapshot: Record<string, unknown>;
    partySnapshot: Record<string, unknown>;
    issuerSnapshot: Record<string, unknown>;
    termsSnapshot: Record<string, unknown>;
    canonicalRenderJson: string;
    documentSchemaHash: string;
    pricingHash: string;
    templateHash: string;
    contentHash: string;
    clientName: string;
    clientCompany: string | null;
    clientEmail: string | null;
    clientPhone: string | null;
    projectName: string;
    purchaseOrderNumber: null;
    referenceNumber: string | null;
    selectedOptionIds: string[];
    subtotalMinCents: number;
    subtotalMaxCents: number;
    discountMinCents: number;
    discountMaxCents: number;
    feeMinCents: 0;
    feeMaxCents: 0;
    totalMinCents: number;
    totalMaxCents: number;
    depositCents: number;
    balanceMinCents: number;
    balanceMaxCents: number;
    scope: string | null;
    assumptions: null;
    exclusions: null;
    terms: null;
    paymentTerms: null;
    internalNotes: string | null;
    validFrom: Date | null;
    expiresAt: Date | null;
    readyAt: Date | null;
    issuedAt: Date | null;
    firstSentAt: Date | null;
    supersededAt: null;
    createdByTeamMemberId: null;
    createdAt: Date;
    updatedAt: Date;
  };
  lineItems: PreparedLegacyLineItem[];
  adjustments: PreparedLegacyAdjustment[];
  capability: PreparedLegacyCapability | null;
  quotePatch: {
    salesOpportunityId: string;
    currentVersionId: string;
    publishedVersionId: string | null;
    aggregateState: QuoteAggregateState;
    aggregateRevision: number;
    updatedAt: Date;
  };
  reviews: QuoteMigrationReview[];
};

export type QuoteV2BackfillCheckpoint = {
  status: "pending" | "running" | "paused" | "completed" | "failed";
  cursor: LegacyQuoteBackfillCursor | null;
};

export type PersistPreparedQuoteResult = {
  outcome: "migrated" | "review" | "skipped";
  additionalReviews?: QuoteMigrationReview[];
};

export interface QuoteV2LegacyBackfillStore {
  startCheckpoint(input: {
    jobKey: string;
    checkpointKey: string;
    now: Date;
  }): Promise<QuoteV2BackfillCheckpoint>;
  loadBatch(input: {
    cursor: LegacyQuoteBackfillCursor | null;
    limit: number;
  }): Promise<LegacyQuoteBackfillRow[]>;
  persistPreparedQuote(
    prepared: PreparedLegacyQuoteBackfill,
  ): Promise<PersistPreparedQuoteResult>;
  advanceCheckpoint(input: {
    jobKey: string;
    checkpointKey: string;
    cursor: LegacyQuoteBackfillCursor;
    scannedDelta: number;
    migratedDelta: number;
    reviewDelta: number;
    skippedDelta: number;
    status: "running" | "paused";
    now: Date;
  }): Promise<void>;
  completeCheckpoint(input: {
    jobKey: string;
    checkpointKey: string;
    cursor: LegacyQuoteBackfillCursor | null;
    now: Date;
  }): Promise<void>;
  failCheckpoint(input: {
    jobKey: string;
    checkpointKey: string;
    errorCode: string;
    now: Date;
  }): Promise<void>;
}

export type QuoteV2LegacyBackfillSummary = {
  dryRun: boolean;
  status: "paused" | "completed";
  scannedCount: number;
  migratedCount: number;
  reviewCount: number;
  skippedCount: number;
  reviewItemCount: number;
  batches: number;
  cursor: LegacyQuoteBackfillCursor | null;
};

function normalizeDate(value: Date): string {
  return value.toISOString();
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(`${namespace}:${value}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decimalSource(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
  }
  return null;
}

export function legacyDecimalToCents(value: unknown): {
  cents: number;
  valid: boolean;
  rounded: boolean;
} {
  const source = decimalSource(value);
  const match = source?.match(/^([+-]?)(\d+)(?:\.(\d+))?$/u);
  if (!match) return { cents: 0, valid: false, rounded: false };

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const fraction = match[3] ?? "";
  const hundredths = BigInt((fraction + "00").slice(0, 2));
  const remainder = fraction.slice(2);
  const roundUp = remainder.length > 0 && Number(remainder[0]) >= 5;
  const absolute = whole * 100n + hundredths + (roundUp ? 1n : 0n);
  const signed = sign * absolute;
  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return { cents: 0, valid: false, rounded: false };
  }
  return {
    cents: Number(signed),
    valid: true,
    rounded: remainder.length > 0 && /[^0]/u.test(remainder),
  };
}

function displayName(row: LegacyQuoteBackfillRow): string {
  const name = `${row.contact.firstName} ${row.contact.lastName}`.trim();
  return name || "Legacy client";
}

function safeReference(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 80) : null;
}

function fallbackQuoteNumber(quoteId: string): string {
  return `LEGACY-${quoteId.replace(/-/gu, "").toUpperCase()}`;
}

function uniqueStringIssues(
  value: unknown,
  duplicateReason: QuoteMigrationReviewReason,
): QuoteMigrationReview[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  const duplicates = [
    ...new Set(
      normalized.filter((entry, index) => normalized.indexOf(entry) !== index),
    ),
  ];
  return duplicates.length
    ? [
        {
          reasonCode: duplicateReason,
          details: { duplicateCount: duplicates.length },
        },
      ]
    : [];
}

function normalizeLineKey(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim())
    return `legacy-line-${index + 1}`;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || `legacy-line-${index + 1}`;
}

function prepareLineItems(input: {
  quoteId: string;
  versionId: string;
  lineItems: unknown;
  createdAt: Date;
}): { lineItems: PreparedLegacyLineItem[]; reviews: QuoteMigrationReview[] } {
  if (!Array.isArray(input.lineItems)) {
    return {
      lineItems: [],
      reviews: [
        {
          reasonCode: "invalid_line_items_shape",
          details: { receivedType: typeof input.lineItems },
        },
      ],
    };
  }

  const reviews: QuoteMigrationReview[] = [];
  const usedKeys = new Set<string>();
  const lineItems: PreparedLegacyLineItem[] = [];

  input.lineItems.forEach((entry, sourceIndex) => {
    if (lineItems.length > 10_000) {
      reviews.push({
        reasonCode: "invalid_line_item",
        details: { sourceIndex, issue: "maximum_imported_line_count" },
      });
      return;
    }
    if (!entry || typeof entry !== "object") {
      reviews.push({
        reasonCode: "invalid_line_item",
        details: { sourceIndex },
      });
      return;
    }
    const legacy = entry as Record<string, unknown>;
    const money = legacyDecimalToCents(legacy["amount"]);
    if (!money.valid || money.cents <= 0 || money.cents > PG_INTEGER_MAX) {
      // Aggregate discounts are imported as adjustments, not negative lines.
      if (
        !(money.valid && money.cents < 0 && legacy["category"] === "discount")
      ) {
        reviews.push({
          reasonCode: "invalid_line_item",
          details: { sourceIndex, issue: "amount" },
        });
      }
      return;
    }

    const baseKey = normalizeLineKey(legacy["id"], sourceIndex);
    let lineKey = baseKey;
    let collisionSuffix = 1;
    while (usedKeys.has(lineKey)) {
      collisionSuffix += 1;
      lineKey = `${baseKey.slice(0, 70)}-${collisionSuffix}`;
    }
    if (lineKey !== baseKey) {
      reviews.push({
        reasonCode: "duplicate_line_item_key",
        details: { sourceIndex },
      });
    }
    usedKeys.add(lineKey);

    const label =
      typeof legacy["label"] === "string" && legacy["label"].trim()
        ? legacy["label"].trim().slice(0, 240)
        : `Legacy line item ${sourceIndex + 1}`;
    lineItems.push({
      id: deterministicUuid(
        "quote-v2-legacy-line",
        `${input.quoteId}:${lineKey}`,
      ),
      quoteVersionId: input.versionId,
      lineKey,
      catalogKey:
        typeof legacy["id"] === "string" && legacy["id"].trim()
          ? legacy["id"].trim().slice(0, 120)
          : null,
      name: label,
      description: null,
      quantity: "1.000",
      unit: "item",
      unitPriceMinCents: money.cents,
      unitPriceMaxCents: money.cents,
      amountMinCents: money.cents,
      amountMaxCents: money.cents,
      optionGroupId: null,
      selectedByDefault: false,
      displayOrder: lineItems.length,
      metadata: {
        provenance: "legacy_current_state",
        legacyCategory:
          typeof legacy["category"] === "string" ? legacy["category"] : null,
        valueRoundedToCents: money.rounded,
      },
      createdAt: input.createdAt,
    });
  });

  return { lineItems, reviews };
}

function readMoney(
  value: unknown,
  field: string,
  reviews: QuoteMigrationReview[],
): number {
  const parsed = legacyDecimalToCents(value);
  if (
    !parsed.valid ||
    parsed.cents > PG_INTEGER_MAX ||
    parsed.cents < -PG_INTEGER_MAX
  ) {
    reviews.push({
      reasonCode: "invalid_financial_value",
      details: { field },
    });
    return 0;
  }
  return parsed.cents;
}

function targetStateFor(
  row: LegacyQuoteBackfillRow,
  issueable: boolean,
  now: Date,
): QuoteVersionState {
  if (!issueable || row.status === "pending") return "draft";
  if (row.status === "accepted") return "accepted";
  if (row.status === "declined") return "declined";
  return row.expiresAt && row.expiresAt.getTime() <= now.getTime()
    ? "expired"
    : "issued";
}

function aggregateStateFor(target: QuoteVersionState): QuoteAggregateState {
  if (target === "accepted") return "accepted";
  if (target === "declined") return "declined";
  if (target === "issued" || target === "expired") return "open";
  return "draft";
}

function lifecyclePath(target: QuoteVersionState): QuoteVersionState[] {
  if (target === "draft") return [];
  if (target === "ready") return ["ready"];
  if (target === "issued") return ["ready", "issued"];
  return ["ready", "issued", target];
}

export function quoteVersionBackfillLifecyclePath(
  target: QuoteVersionState,
): QuoteVersionState[] {
  return lifecyclePath(target);
}

export function revokePreparedLegacyCapabilityForInactiveContact(
  capability: PreparedLegacyCapability,
  deletedAt: Date,
): PreparedLegacyCapability {
  const revokedAt = new Date(
    Math.max(capability.issuedAt.getTime(), deletedAt.getTime()),
  );
  return {
    ...capability,
    allowedActions: ["view", "pdf"],
    status: "revoked",
    actionExpiresAt: null,
    revokedAt,
    revocationReason: "contact_inactive",
    updatedAt: revokedAt,
  };
}

export function prepareLegacyQuoteBackfill(
  row: LegacyQuoteBackfillRow,
  options: { now: Date; recipientHashSecret: string },
): PreparedLegacyQuoteBackfill {
  if (options.recipientHashSecret.length < 32) {
    throw new Error(
      "Quote legacy recipient HMAC secret must contain at least 32 characters",
    );
  }
  const reviews: QuoteMigrationReview[] = [];
  const opportunityId = deterministicUuid(
    "quote-v2-legacy-opportunity",
    row.id,
  );
  const versionId = deterministicUuid("quote-v2-legacy-version", `${row.id}:1`);
  const quoteNumber =
    safeReference(row.quoteNumber) ?? fallbackQuoteNumber(row.id);

  if (!safeReference(row.quoteNumber)) {
    reviews.push({ reasonCode: "quote_number_missing", details: {} });
  }
  if (row.quoteNumberCollision) {
    reviews.push({ reasonCode: "quote_number_collision", details: {} });
  }
  if (row.activeHoldCount > 1) {
    reviews.push({
      reasonCode: "duplicate_active_hold",
      details: { count: row.activeHoldCount },
    });
  }
  if (row.acceptedAppointmentReferenceCount > 1) {
    reviews.push({
      reasonCode: "duplicate_accepted_appointment_reference",
      details: { count: row.acceptedAppointmentReferenceCount },
    });
  }
  if (
    !row.hasCanonicalContactPropertyLink &&
    row.property.legacyContactId !== row.contactId
  ) {
    reviews.push({
      reasonCode: "ambiguous_property_association",
      details: { propertyId: row.propertyId },
    });
  }

  const validLeads = row.linkedLeadCandidates.filter(
    (lead) =>
      lead.contactId === row.contactId && lead.propertyId === row.propertyId,
  );
  const invalidLeads = row.linkedLeadCandidates.length - validLeads.length;
  if (row.linkedLeadCandidates.length > 1) {
    reviews.push({
      reasonCode: "duplicate_lead_association",
      details: { count: row.linkedLeadCandidates.length },
    });
  }
  if (invalidLeads > 0) {
    reviews.push({
      reasonCode: "ambiguous_lead_association",
      details: { invalidCandidateCount: invalidLeads },
    });
  }
  const leadId = validLeads.length === 1 ? validLeads[0]!.id : null;

  const ownerTeamMemberId =
    row.contact.salespersonMemberId && row.ownerTeamMemberExists
      ? row.contact.salespersonMemberId
      : null;
  if (row.contact.salespersonMemberId && !ownerTeamMemberId) {
    reviews.push({
      reasonCode: "invalid_owner_reference",
      details: {},
    });
  }

  reviews.push(
    ...uniqueStringIssues(row.services, "duplicate_service_identifier"),
    ...uniqueStringIssues(row.addOns, "duplicate_add_on_identifier"),
  );

  const rawSubtotal = readMoney(row.subtotal, "subtotal", reviews);
  const rawDiscount = readMoney(row.discounts, "discounts", reviews);
  const rawTotal = readMoney(row.total, "total", reviews);
  const rawDeposit = readMoney(row.depositDue, "depositDue", reviews);
  const rawBalance = readMoney(row.balanceDue, "balanceDue", reviews);
  const rawTravel = readMoney(row.travelFee, "travelFee", reviews);
  const rawAddOns = readMoney(row.addOnsTotal, "addOnsTotal", reviews);

  const totalCents = Math.max(0, rawTotal);
  const discountCents = Math.min(
    Math.max(0, rawDiscount),
    PG_INTEGER_MAX - totalCents,
  );
  if (Math.max(0, rawDiscount) !== discountCents) {
    reviews.push({
      reasonCode: "invalid_financial_value",
      details: { field: "normalizedSubtotal" },
    });
  }
  // Preserve the legacy customer-visible total and make the imported V2
  // equation exact. The original subtotal remains in documentSnapshot.
  const subtotalCents = totalCents + discountCents;
  const depositCents = Math.min(Math.max(0, rawDeposit), totalCents);
  const balanceCents = totalCents - depositCents;

  if (rawSubtotal !== subtotalCents || rawTotal !== rawSubtotal - rawDiscount) {
    reviews.push({
      reasonCode: "invalid_total_equation",
      details: {
        rawSubtotalCents: rawSubtotal,
        rawDiscountCents: rawDiscount,
        rawTotalCents: rawTotal,
      },
    });
  }
  if (
    rawDeposit < 0 ||
    rawDeposit > totalCents ||
    rawBalance !== balanceCents
  ) {
    reviews.push({
      reasonCode: "invalid_deposit_equation",
      details: {
        rawDepositCents: rawDeposit,
        rawBalanceCents: rawBalance,
        normalizedDepositCents: depositCents,
        normalizedBalanceCents: balanceCents,
      },
    });
  }
  if (totalCents <= 0 && row.status !== "pending") {
    reviews.push({
      reasonCode: "invalid_zero_total",
      details: { legacyStatus: row.status },
    });
  }

  const hasIssuedLifecycle = row.status !== "pending";
  const hasValidIssueTime = row.sentAt instanceof Date;
  const hasValidExpiry =
    row.expiresAt instanceof Date &&
    row.sentAt instanceof Date &&
    row.expiresAt.getTime() > row.sentAt.getTime();
  if (hasIssuedLifecycle && !hasValidExpiry) {
    reviews.push({ reasonCode: "invalid_expiry", details: {} });
  }
  const issueable =
    hasIssuedLifecycle && hasValidIssueTime && hasValidExpiry && totalCents > 0;
  if (hasIssuedLifecycle && !issueable) {
    reviews.push({
      reasonCode: "legacy_state_not_issueable",
      details: { legacyStatus: row.status },
    });
  }
  const targetState = targetStateFor(row, issueable, options.now);
  const aggregateState = aggregateStateFor(targetState);

  const preparedLines = prepareLineItems({
    quoteId: row.id,
    versionId,
    lineItems: row.lineItems,
    createdAt: row.createdAt,
  });
  reviews.push(...preparedLines.reviews);

  const adjustment: PreparedLegacyAdjustment | null =
    discountCents > 0
      ? {
          id: deterministicUuid(
            "quote-v2-legacy-adjustment",
            `${row.id}:discount`,
          ),
          quoteVersionId: versionId,
          adjustmentKey: "legacy-discount",
          kind: "discount",
          label: "Legacy discount",
          calculation: "fixed",
          basis: "subtotal",
          eligibleLineItemKeys: [],
          amountCents: discountCents,
          basisPoints: null,
          amountMinCents: discountCents,
          amountMaxCents: discountCents,
          displayOrder: preparedLines.lineItems.length,
          metadata: {
            provenance: "legacy_current_state",
            evidenceQuality: "legacy_imported_incomplete",
          },
          createdAt: row.createdAt,
        }
      : null;

  const clientName = displayName(row);
  const projectName =
    row.contact.company?.trim() ||
    row.clientScope?.trim().slice(0, 120) ||
    `Project ${quoteNumber}`;
  const partySnapshot = {
    customer: {
      contactId: row.contactId,
      name: clientName,
      company: row.contact.company,
      email: row.contact.email,
      phone: row.contact.phoneE164 ?? row.contact.phone,
    },
    serviceSite: {
      propertyId: row.propertyId,
      addressLine1: row.property.addressLine1,
      addressLine2: row.property.addressLine2,
      city: row.property.city,
      state: row.property.state,
      postalCode: row.property.postalCode,
    },
  };
  const issuerSnapshot = {
    provenance: "legacy_current_state",
    evidenceQuality: "unavailable_in_legacy_record",
  };
  const termsSnapshot = {
    provenance: "legacy_current_state",
    evidenceQuality: "legacy_imported_incomplete",
    exactOriginallySentDocumentReconstructable: false,
    exactAcceptanceEvidenceAvailable: false,
  };
  const pricingSnapshot = {
    currency: "USD",
    subtotalCents,
    discountCents,
    feeCents: 0,
    totalCents,
    depositCents,
    balanceCents,
    legacyRawCents: {
      subtotal: rawSubtotal,
      discounts: rawDiscount,
      total: rawTotal,
      deposit: rawDeposit,
      balance: rawBalance,
      travel: rawTravel,
      addOns: rawAddOns,
    },
  };
  const documentSnapshot = {
    schemaVersion: QUOTE_V2_LEGACY_SCHEMA_VERSION,
    provenance: "legacy_current_state",
    evidenceQuality: "legacy_imported_incomplete",
    exactOriginallySentDocumentReconstructable: false,
    exactAcceptanceEvidenceAvailable: false,
    quoteId: row.id,
    quoteNumber,
    legacyStatus: row.status,
    legacyRevision: row.revision,
    services: Array.isArray(row.services) ? row.services : [],
    addOns: Array.isArray(row.addOns) ? row.addOns : [],
    surfaceArea: decimalSource(row.surfaceArea),
    zoneId: row.zoneId,
    jobDurationMinutes: row.jobDurationMinutes,
    clientScope: row.clientScope,
    lifecycle: {
      sentAt: row.sentAt ? normalizeDate(row.sentAt) : null,
      expiresAt: row.expiresAt ? normalizeDate(row.expiresAt) : null,
      viewedAt: row.viewedAt ? normalizeDate(row.viewedAt) : null,
      lastViewedAt: row.lastViewedAt ? normalizeDate(row.lastViewedAt) : null,
      viewCount: row.viewCount,
      decisionAt: row.decisionAt ? normalizeDate(row.decisionAt) : null,
      refreshRequestedAt: row.refreshRequestedAt
        ? normalizeDate(row.refreshRequestedAt)
        : null,
      acceptedAppointmentId: row.acceptedAppointmentId,
    },
    pricing: pricingSnapshot,
    lineItems: preparedLines.lineItems.map((line) => ({
      key: line.lineKey,
      name: line.name,
      amountCents: line.amountMinCents,
    })),
  };
  const canonicalRenderJson = canonicalQuoteJson({
    documentType: "fixed_quote",
    audience: row.contact.company ? "commercial" : "residential",
    quoteNumber,
    versionNumber: 1,
    parties: partySnapshot,
    issuer: issuerSnapshot,
    terms: termsSnapshot,
    pricing: pricingSnapshot,
    scope: row.clientScope,
    lines: documentSnapshot.lineItems,
  });

  const issuedAt = issueable ? row.sentAt : null;
  const expiresAt = issueable ? row.expiresAt : null;
  const capabilityIssuedAt = options.now;
  const acceptedRead = row.status === "accepted" && targetState === "accepted";
  const actionCapable =
    targetState === "issued" &&
    expiresAt !== null &&
    expiresAt.getTime() > options.now.getTime();
  const refreshCapable =
    targetState === "expired" &&
    aggregateState === "open" &&
    expiresAt !== null &&
    expiresAt.getTime() <= options.now.getTime() &&
    row.refreshRequestedAt === null;
  const tokenHash = row.shareToken
    ? createHash("sha256").update(row.shareToken, "utf8").digest("hex")
    : null;
  const rawRecipient =
    row.contact.email?.trim().toLowerCase() || row.contact.phoneE164;
  const recipientHashIdentity = rawRecipient
    ? `address:${rawRecipient}`
    : `unavailable:${row.id}:${tokenHash ?? "no-capability"}`;
  const recipientAddressHash = createHmac("sha256", options.recipientHashSecret)
    .update(`quote-v2-legacy-recipient:${recipientHashIdentity}`, "utf8")
    .digest("hex");
  if (row.shareToken && !rawRecipient) {
    reviews.push({
      reasonCode: "ambiguous_capability_recipient",
      details: {},
    });
  }
  const baseReadExpiry =
    capabilityIssuedAt.getTime() +
    (acceptedRead ? LEGACY_ACCEPTED_READ_DAYS : LEGACY_READ_DAYS) * DAY_MS;
  const readExpiresAt = new Date(
    Math.max(
      baseReadExpiry,
      actionCapable && expiresAt
        ? expiresAt.getTime() + LEGACY_READ_DAYS * DAY_MS
        : baseReadExpiry,
    ),
  );
  const activeCapability: PreparedLegacyCapability | null =
    tokenHash === null
      ? null
      : {
          id: deterministicUuid(
            "quote-v2-legacy-capability",
            `${row.id}:${tokenHash}`,
          ),
          quoteId: row.id,
          quoteVersionId: versionId,
          recipientRole: "signer",
          recipientAddressHash,
          allowedActions: actionCapable
            ? [
                "view",
                "pdf",
                "change",
                "refresh",
                "accept",
                "decline",
                "availability",
                "hold",
                "checkout",
                "book",
              ]
            : refreshCapable
              ? ["view", "pdf", "refresh"]
              : ["view", "pdf"],
          tokenHash,
          status: "active",
          readExpiresAt,
          actionExpiresAt: actionCapable ? expiresAt : null,
          issuedAt: capabilityIssuedAt,
          revokedAt: null,
          revocationReason: null,
          useCount: 0,
          createdAt: capabilityIssuedAt,
          updatedAt: capabilityIssuedAt,
        };
  const capability =
    activeCapability && row.contact.deletedAt
      ? revokePreparedLegacyCapabilityForInactiveContact(
          activeCapability,
          row.contact.deletedAt,
        )
      : activeCapability;
  const uniqueReviews = [
    ...new Map(
      reviews.map((review) => [
        `${review.reasonCode}:${canonicalQuoteJson(review.details)}`,
        review,
      ]),
    ).values(),
  ];

  return {
    quoteId: row.id,
    cursor: { createdAt: row.createdAt.toISOString(), id: row.id },
    opportunity: {
      id: opportunityId,
      contactId: row.contactId,
      propertyId: row.propertyId,
      leadId,
      ownerTeamMemberId,
      name: projectName.slice(0, 240),
      status:
        row.status === "accepted"
          ? "approved"
          : row.status === "declined"
            ? "lost"
            : "open",
      pipelineStage: "quoted",
      currency: "USD",
      estimatedValueCents: totalCents,
      revision: 1,
      closedAt:
        row.status === "declined" ? (row.decisionAt ?? row.updatedAt) : null,
      metadata: {
        provenance: "legacy_current_state",
        legacyQuoteId: row.id,
        evidenceQuality: "legacy_imported_incomplete",
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    version: {
      id: versionId,
      quoteId: row.id,
      versionNumber: 1,
      draftRevision: Math.max(1, row.revision),
      supersedesVersionId: null,
      initialState: "draft",
      targetState,
      provenance: "legacy_current_state",
      schemaVersion: QUOTE_V2_LEGACY_SCHEMA_VERSION,
      documentType: "fixed_quote",
      audience: row.contact.company ? "commercial" : "residential",
      schedulingMode: "self_schedule",
      currency: "USD",
      documentSnapshot,
      partySnapshot,
      issuerSnapshot,
      termsSnapshot,
      canonicalRenderJson,
      documentSchemaHash: hashQuoteContent({
        schemaVersion: QUOTE_V2_LEGACY_SCHEMA_VERSION,
        documentType: "fixed_quote",
      }),
      pricingHash: hashQuoteContent(pricingSnapshot),
      templateHash: hashQuoteContent({
        template: "legacy_current_state",
        exactTemplateAvailable: false,
      }),
      contentHash: hashQuoteContent(JSON.parse(canonicalRenderJson) as unknown),
      clientName,
      clientCompany: row.contact.company,
      clientEmail: row.contact.email,
      clientPhone: row.contact.phoneE164 ?? row.contact.phone,
      projectName,
      purchaseOrderNumber: null,
      referenceNumber: safeReference(row.quoteNumber),
      selectedOptionIds: [],
      subtotalMinCents: subtotalCents,
      subtotalMaxCents: subtotalCents,
      discountMinCents: discountCents,
      discountMaxCents: discountCents,
      feeMinCents: 0,
      feeMaxCents: 0,
      totalMinCents: totalCents,
      totalMaxCents: totalCents,
      depositCents,
      balanceMinCents: balanceCents,
      balanceMaxCents: balanceCents,
      scope: row.clientScope,
      assumptions: null,
      exclusions: null,
      terms: null,
      paymentTerms: null,
      internalNotes: row.notes,
      validFrom: issuedAt,
      expiresAt,
      readyAt: issuedAt,
      issuedAt,
      firstSentAt: issuedAt,
      supersededAt: null,
      createdByTeamMemberId: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    lineItems: preparedLines.lineItems,
    adjustments: adjustment ? [adjustment] : [],
    capability,
    quotePatch: {
      salesOpportunityId: opportunityId,
      currentVersionId: versionId,
      publishedVersionId: targetState === "draft" ? null : versionId,
      aggregateState,
      aggregateRevision: Math.max(1, row.revision),
      updatedAt: row.updatedAt,
    },
    reviews: uniqueReviews,
  };
}

export async function runQuoteV2LegacyBackfill(input: {
  store: QuoteV2LegacyBackfillStore;
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
  now?: Date;
  cursor?: LegacyQuoteBackfillCursor | null;
  recipientHashSecret?: string;
}): Promise<QuoteV2LegacyBackfillSummary> {
  const now = input.now ?? new Date();
  const dryRun = input.dryRun === true;
  const batchSize = Math.max(
    1,
    Math.min(MAX_BATCH_SIZE, input.batchSize ?? 100),
  );
  const maxBatches = Math.max(1, input.maxBatches ?? Number.MAX_SAFE_INTEGER);
  const recipientHashSecret =
    input.recipientHashSecret ??
    process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"]?.trim();
  if (!recipientHashSecret || recipientHashSecret.length < 32) {
    throw new Error(
      "QUOTE_RATE_LIMIT_HMAC_SECRET must contain at least 32 characters for the legacy quote backfill",
    );
  }
  const checkpoint = dryRun
    ? { status: "pending" as const, cursor: input.cursor ?? null }
    : await input.store.startCheckpoint({
        jobKey: QUOTE_V2_LEGACY_BACKFILL_JOB,
        checkpointKey: QUOTE_V2_LEGACY_BACKFILL_CHECKPOINT,
        now,
      });

  if (!dryRun && checkpoint.status === "completed") {
    return {
      dryRun: false,
      status: "completed",
      scannedCount: 0,
      migratedCount: 0,
      reviewCount: 0,
      skippedCount: 0,
      reviewItemCount: 0,
      batches: 0,
      cursor: checkpoint.cursor,
    };
  }

  let cursor = input.cursor ?? checkpoint.cursor;
  let scannedCount = 0;
  let migratedCount = 0;
  let reviewCount = 0;
  let skippedCount = 0;
  let reviewItemCount = 0;
  let batches = 0;

  try {
    while (batches < maxBatches) {
      const rows = await input.store.loadBatch({ cursor, limit: batchSize });
      if (rows.length === 0) {
        if (!dryRun) {
          await input.store.completeCheckpoint({
            jobKey: QUOTE_V2_LEGACY_BACKFILL_JOB,
            checkpointKey: QUOTE_V2_LEGACY_BACKFILL_CHECKPOINT,
            cursor,
            now: new Date(),
          });
        }
        return {
          dryRun,
          status: "completed",
          scannedCount,
          migratedCount,
          reviewCount,
          skippedCount,
          reviewItemCount,
          batches,
          cursor,
        };
      }

      let batchMigrated = 0;
      let batchReview = 0;
      let batchSkipped = 0;
      for (const row of rows) {
        const prepared = prepareLegacyQuoteBackfill(row, {
          now,
          recipientHashSecret,
        });
        reviewItemCount += prepared.reviews.length;
        if (dryRun) {
          if (prepared.reviews.length > 0) batchReview += 1;
          else batchMigrated += 1;
          continue;
        }

        const persisted = await input.store.persistPreparedQuote(prepared);
        reviewItemCount += persisted.additionalReviews?.length ?? 0;
        if (persisted.outcome === "migrated") batchMigrated += 1;
        else if (persisted.outcome === "review") batchReview += 1;
        else batchSkipped += 1;
      }

      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.createdAt.toISOString(), id: last.id };
      batches += 1;
      scannedCount += rows.length;
      migratedCount += batchMigrated;
      reviewCount += batchReview;
      skippedCount += batchSkipped;

      if (!dryRun) {
        await input.store.advanceCheckpoint({
          jobKey: QUOTE_V2_LEGACY_BACKFILL_JOB,
          checkpointKey: QUOTE_V2_LEGACY_BACKFILL_CHECKPOINT,
          cursor,
          scannedDelta: rows.length,
          migratedDelta: batchMigrated,
          reviewDelta: batchReview,
          skippedDelta: batchSkipped,
          status: batches >= maxBatches ? "paused" : "running",
          now: new Date(),
        });
      }
    }

    return {
      dryRun,
      status: "paused",
      scannedCount,
      migratedCount,
      reviewCount,
      skippedCount,
      reviewItemCount,
      batches,
      cursor,
    };
  } catch (error) {
    if (!dryRun) {
      await input.store.failCheckpoint({
        jobKey: QUOTE_V2_LEGACY_BACKFILL_JOB,
        checkpointKey: QUOTE_V2_LEGACY_BACKFILL_CHECKPOINT,
        errorCode:
          error instanceof Error && error.name
            ? `backfill_${error.name.toLowerCase()}`.slice(0, 120)
            : "backfill_unknown_error",
        now: new Date(),
      });
    }
    throw error;
  }
}
