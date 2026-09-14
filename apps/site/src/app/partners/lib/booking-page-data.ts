import type {
  PartnerAvailability,
  PartnerDraft,
  PartnerLocation,
} from "./portal-v2";
import { z } from "zod";
import { isPartnerLocation, toBookingLocation } from "./booking-location";
import type {
  BookingWizardAddOn,
  BookingWizardBaseOption,
  BookingWizardCancellationPolicy,
  BookingWizardLocation,
  BookingWizardMoney,
  BookingWizardService,
} from "../components/PartnerBookingWizard";

type CatalogItem = {
  key?: string;
  label?: string | null;
  description?: string | null;
  pricingStatus?: string;
  bookable?: unknown;
  priceState?: unknown;
  agreement?: unknown;
  inclusions?: unknown;
  exclusions?: unknown;
  quoteRule?: unknown;
  basePrice?: unknown;
  baseOptions?: unknown;
  addOns?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nullableText = z.string().nullable();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const draftSchema = z.object({
  id: z.string().min(1),
  rescheduleFromJobId: nullableText,
  additionalServiceFromJobId: nullableText,
  state: z.string(),
  locationId: nullableText,
  serviceKey: nullableText,
  tierKey: nullableText,
  selectedAddOns: z.array(
    z.object({ key: z.string(), quantity: z.number().finite() }),
  ),
  scope: z.record(z.unknown()),
  description: nullableText,
  crewInstructions: nullableText,
  accessDetails: nullableText,
  onSiteContact: z.record(z.unknown()).nullable(),
  proofRequirements: z.record(z.unknown()),
  commercial: z.record(z.unknown()),
  preferredWindows: z.array(z.record(z.unknown())),
  scheduleAssistancePreference: z.enum(["none", "waitlist", "callback"]),
  reviewReasons: z.array(z.string()),
  validation: z.record(z.unknown()),
  revision: z.number().int().safe(),
  expiresAt: date.nullable(),
  submittedAt: date.nullable(),
  createdAt: date,
  updatedAt: date,
  etag: z.string().min(1),
});

export function parseBookingDraft(payload: unknown): PartnerDraft | null {
  if (!isRecord(payload) || payload["ok"] !== true) return null;
  return draftSchema.safeParse(payload["draft"]).success
    ? (payload["draft"] as PartnerDraft)
    : null;
}

export function parseBookingDrafts(
  payload: unknown,
): { drafts: PartnerDraft[]; nextCursor: string | null } | null {
  if (
    !isRecord(payload) ||
    payload["ok"] !== true ||
    !Array.isArray(payload["drafts"]) ||
    !isRecord(payload["page"])
  )
    return null;
  const drafts = payload["drafts"].map((draft: unknown) =>
    parseBookingDraft({ ok: true, draft }),
  );
  const cursor = payload["page"]["nextCursor"];
  if (
    drafts.some((draft) => draft === null) ||
    !(cursor === null || typeof cursor === "string")
  )
    return null;
  return { drafts: drafts as PartnerDraft[], nextCursor: cursor };
}

const moneySchema = z.object({
  amountMinor: z.number().int().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  minorUnit: z.number().int().min(0).max(6),
});
const windowSchema = z.object({
  id: z.string(),
  localDate: z.string(),
  startAt: date,
  endAt: date,
  label: z.string(),
  available: z.boolean(),
});
const availabilitySchema = z.object({
  draft: draftSchema,
  timezone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  calendar: z.object({ state: z.enum(["current", "stale", "unconfigured"]) }),
  reviewReasons: z.array(z.string()),
  instantConfirmationEligible: z.boolean(),
  pricing: z.object({
    status: z.enum([
      "contracted",
      "estimate",
      "quote_required",
      "standard_rate",
      "review_required",
      "hidden",
    ]),
    currency: nullableText,
    baseAmount: moneySchema.nullable(),
    addOnTotal: moneySchema.nullable(),
    total: moneySchema.nullable(),
    addOns: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        unitLabel: z.string(),
        quantity: z.number(),
        requiresReview: z.boolean(),
        unitAmount: moneySchema.nullable(),
        lineTotal: moneySchema.nullable(),
      }),
    ),
  }),
  windows: z.array(windowSchema),
  rankedAlternatives: z.array(
    windowSchema.extend({
      rank: z.number(),
      reason: z.enum(["preferred_date", "soonest_available", "more_capacity"]),
    }),
  ),
});

export function parseBookingAvailability(
  payload: unknown,
): PartnerAvailability | null {
  if (!isRecord(payload) || payload["ok"] !== true) return null;
  const result = availabilitySchema.safeParse(payload["availability"]);
  return result.success ? result.data : null;
}

export function parseBookingValidation(payload: unknown): {
  draft: PartnerDraft;
  validation: {
    valid: boolean;
    ready: boolean;
    fieldErrors: Record<string, string>;
  };
} | null {
  const draft = parseBookingDraft(payload);
  if (!draft || !isRecord(payload)) return null;
  const result = z
    .object({
      valid: z.boolean(),
      ready: z.boolean(),
      fieldErrors: z.record(z.string()),
    })
    .safeParse(payload["validation"]);
  return result.success ? { draft, validation: result.data } : null;
}

export function parseLocations(payload: unknown): PartnerLocation[] | null {
  if (
    !isRecord(payload) ||
    payload["ok"] !== true ||
    !isRecord(payload["directory"]) ||
    typeof payload["directory"]["canCreateLocation"] !== "boolean"
  )
    return null;
  const candidate = Array.isArray(payload["data"])
    ? payload["data"]
    : Array.isArray(payload["locations"])
      ? payload["locations"]
      : null;
  if (!candidate) return null;
  const locations = candidate.filter(isPartnerLocation);
  return locations.length === candidate.length
    ? locations.filter((location) => location.active)
    : null;
}

export function wizardLocation(
  location: PartnerLocation,
): BookingWizardLocation {
  return toBookingLocation(location);
}

function parseMoney(value: unknown): BookingWizardMoney | null {
  if (!isRecord(value)) return null;
  const amountMinor = value["amountMinor"];
  const currency = value["currency"];
  const minorUnit = value["minorUnit"];
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    minorUnit !== 2
  ) {
    return null;
  }
  return { amountMinor, currency, minorUnit };
}

function parsePricingStatus(
  value: unknown,
): "contracted" | "review_required" | "hidden" {
  return value === "contracted" ||
    value === "review_required" ||
    value === "hidden"
    ? value
    : "review_required";
}

function parsePriceState(
  value: unknown,
): "contracted" | "estimate" | "quote_required" | "standard_rate" | null {
  return value === "contracted" ||
    value === "estimate" ||
    value === "quote_required" ||
    value === "standard_rate"
    ? value
    : null;
}

function parseRateBearingPriceState(
  value: unknown,
): "contracted" | "estimate" | "standard_rate" {
  const state = parsePriceState(value);
  return state === "contracted" || state === "standard_rate"
    ? state
    : "estimate";
}

function parseBoundedTextList(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 40
    ? value.filter(
        (item): item is string =>
          typeof item === "string" &&
          item.trim() === item &&
          item.length > 0 &&
          item.length <= 500,
      )
    : [];
}

function parseAgreement(value: unknown): BookingWizardService["agreement"] {
  if (!isRecord(value)) return null;
  const label = value["label"];
  const currency = value["currency"];
  const effectiveFrom = value["effectiveFrom"];
  const effectiveTo = value["effectiveTo"];
  if (
    typeof label !== "string" ||
    !label.trim() ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    typeof effectiveFrom !== "string" ||
    Number.isNaN(new Date(effectiveFrom).getTime()) ||
    (effectiveTo !== null &&
      (typeof effectiveTo !== "string" ||
        Number.isNaN(new Date(effectiveTo).getTime())))
  ) {
    return null;
  }
  return { label: label.trim(), currency, effectiveFrom, effectiveTo };
}

function parseCatalogAddOns(value: unknown): BookingWizardAddOn[] {
  if (!Array.isArray(value)) return [];
  const result: BookingWizardAddOn[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const key = typeof raw["key"] === "string" ? raw["key"] : "";
    const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
    const unitLabel =
      typeof raw["unitLabel"] === "string" ? raw["unitLabel"].trim() : "";
    const minimumQuantity = raw["minimumQuantity"];
    const maximumQuantity = raw["maximumQuantity"];
    const instantMaximum = raw["instantConfirmationMaxQuantity"];
    if (
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(key) ||
      !label ||
      !unitLabel ||
      seen.has(key) ||
      typeof minimumQuantity !== "number" ||
      !Number.isSafeInteger(minimumQuantity) ||
      typeof maximumQuantity !== "number" ||
      !Number.isSafeInteger(maximumQuantity) ||
      minimumQuantity < 1 ||
      maximumQuantity < minimumQuantity ||
      maximumQuantity > 100 ||
      (instantMaximum !== null &&
        (typeof instantMaximum !== "number" ||
          !Number.isSafeInteger(instantMaximum) ||
          instantMaximum < minimumQuantity ||
          instantMaximum > maximumQuantity))
    ) {
      continue;
    }
    seen.add(key);
    result.push({
      key,
      label,
      priceState: parseRateBearingPriceState(raw["priceState"]),
      ...(typeof raw["description"] === "string" && raw["description"].trim()
        ? { detail: raw["description"].trim() }
        : {}),
      unitLabel,
      minimumQuantity,
      maximumQuantity,
      instantConfirmationMaxQuantity: instantMaximum,
      requiresReview: raw["requiresReview"] === true,
      pricingStatus: parsePricingStatus(raw["pricingStatus"]),
      unitPrice: parseMoney(raw["unitPrice"]),
    });
  }
  return result;
}

function parseCatalogBaseOptions(value: unknown): BookingWizardBaseOption[] {
  if (!Array.isArray(value)) return [];
  const result: BookingWizardBaseOption[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 100)) {
    if (!isRecord(raw)) continue;
    const tierKey =
      typeof raw["tierKey"] === "string" ? raw["tierKey"].trim() : "";
    const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
    if (
      !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(tierKey) ||
      !label ||
      seen.has(tierKey)
    ) {
      continue;
    }
    seen.add(tierKey);
    result.push({
      tierKey,
      label,
      priceState: parseRateBearingPriceState(raw["priceState"]),
      pricingStatus: parsePricingStatus(raw["pricingStatus"]),
      price: parseMoney(raw["price"]),
    });
  }
  return result;
}

export function parseCatalogServices(
  payload: unknown,
): BookingWizardService[] | null {
  if (
    !isRecord(payload) ||
    payload["ok"] !== true ||
    !Array.isArray(payload["services"])
  )
    return null;
  const services = new Map<string, BookingWizardService>();
  for (const raw of payload["services"]) {
    if (
      !isRecord(raw) ||
      typeof raw["key"] !== "string" ||
      typeof raw["label"] !== "string" ||
      (raw["description"] != null && typeof raw["description"] !== "string")
    )
      return null;
    const item = raw as CatalogItem;
    const key = item.key?.trim().toLowerCase() ?? "";
    const label = item.label?.trim() ?? "";
    if (!/^[a-z][a-z0-9_-]{1,79}$/u.test(key) || !label || services.has(key))
      return null;
    services.set(key, {
      key,
      label,
      ...(item.description?.trim() ? { detail: item.description.trim() } : {}),
      pricingStatus: parsePricingStatus(item.pricingStatus),
      bookable: item.bookable === true,
      priceState: parsePriceState(item.priceState) ?? "quote_required",
      agreement: parseAgreement(item.agreement),
      inclusions: parseBoundedTextList(item.inclusions),
      exclusions: parseBoundedTextList(item.exclusions),
      quoteRule:
        typeof item.quoteRule === "string" && item.quoteRule.trim()
          ? item.quoteRule.trim().slice(0, 1_000)
          : null,
      basePrice: parseMoney(item.basePrice),
      baseOptions: parseCatalogBaseOptions(item.baseOptions),
      addOns: parseCatalogAddOns(item.addOns),
    });
  }
  return [...services.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function parseProofDefaults(payload: unknown): {
  before: number;
  after: number;
} | null {
  const defaults = { before: 1, after: 1 };
  if (
    !isRecord(payload) ||
    payload["ok"] !== true ||
    !Array.isArray(payload["requirements"])
  ) {
    return null;
  }
  for (const raw of payload["requirements"]) {
    if (
      !isRecord(raw) ||
      typeof raw["category"] !== "string" ||
      typeof raw["required"] !== "boolean" ||
      !Number.isSafeInteger(raw["minimumCount"]) ||
      Number(raw["minimumCount"]) < 0 ||
      Number(raw["minimumCount"]) > 40
    )
      return null;
    const category = raw["category"];
    const minimumCount = raw["minimumCount"];
    const required = raw["required"];
    if (
      (category === "before" || category === "after") &&
      typeof minimumCount === "number" &&
      Number.isSafeInteger(minimumCount) &&
      minimumCount >= 0 &&
      minimumCount <= 40 &&
      typeof required === "boolean"
    ) {
      defaults[category] = required ? minimumCount : 0;
    }
  }
  return defaults;
}

export function parseCancellationPolicy(
  payload: unknown,
): BookingWizardCancellationPolicy | null {
  if (!isRecord(payload) || !isRecord(payload["policy"])) return null;
  const policy = payload["policy"];
  const minimumNoticeMinutes = policy["minimumNoticeMinutes"];
  const revision = policy["revision"];
  const source = policy["source"];
  if (
    typeof minimumNoticeMinutes !== "number" ||
    !Number.isSafeInteger(minimumNoticeMinutes) ||
    minimumNoticeMinutes < 1_440 ||
    minimumNoticeMinutes > 525_600 ||
    typeof policy["directCancellationEnabled"] !== "boolean" ||
    policy["lateCancellationDisposition"] !== "staff_review" ||
    policy["automaticFeeMinor"] !== null ||
    !["configured", "unconfigured", "launch_default"].includes(
      String(source),
    ) ||
    (revision !== null &&
      (typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1))
  ) {
    return null;
  }
  return {
    minimumNoticeMinutes,
    directCancellationEnabled: policy["directCancellationEnabled"],
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
    source: source as BookingWizardCancellationPolicy["source"],
    revision,
  };
}
