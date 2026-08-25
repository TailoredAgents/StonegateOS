import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "./api";
import type {
  AppointmentBookingDetails,
  AppointmentLeadSource,
} from "./booking-details";

export type InstantQuoteHandoff = {
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
    loadSize: NonNullable<AppointmentBookingDetails["loadSize"]>;
    source: AppointmentLeadSource | null;
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

export type InstantQuoteHandoffLoadResult =
  | { ok: true; handoff: InstantQuoteHandoff }
  | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidHandoff(value: unknown): value is InstantQuoteHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const handoff = value as Partial<InstantQuoteHandoff>;
  const booking = handoff.bookingPrefill;
  const fullQuote = handoff.fullQuotePrefill;
  const loadSize = booking?.loadSize;
  const source = booking?.source;
  const validLoadKinds = new Set([
    "quarter_to_half",
    "half_to_three_quarters",
    "three_quarters_to_full",
    "custom",
  ]);
  const validRange =
    Number.isInteger(booking?.priceRangeMinCents) &&
    Number.isInteger(booking?.priceRangeMaxCents) &&
    (booking?.priceRangeMinCents ?? -1) >= 0 &&
    (booking?.priceRangeMaxCents ?? -1) >= (booking?.priceRangeMinCents ?? 0);
  return (
    isNonEmptyString(handoff.instantQuoteId) &&
    isNonEmptyString(handoff.contactId) &&
    isNonEmptyString(handoff.propertyId) &&
    isNonEmptyString(handoff.leadId) &&
    booking?.appointmentType === "junk_removal" &&
    booking.propertyId === handoff.propertyId &&
    validRange &&
    Boolean(loadSize && validLoadKinds.has(loadSize.kind)) &&
    (loadSize?.customLoads === null ||
      (typeof loadSize?.customLoads === "number" &&
        Number.isFinite(loadSize.customLoads) &&
        loadSize.customLoads > 0)) &&
    (source === null ||
      source?.type === "website" ||
      source?.type === "google" ||
      source?.type === "facebook") &&
    typeof booking.notes === "string" &&
    fullQuote?.propertyId === handoff.propertyId &&
    Array.isArray(fullQuote.serviceIds) &&
    fullQuote.serviceIds.every(isNonEmptyString) &&
    fullQuote.priceRangeMinCents === booking.priceRangeMinCents &&
    fullQuote.priceRangeMaxCents === booking.priceRangeMaxCents &&
    typeof fullQuote.notes === "string"
  );
}

export async function loadInstantQuoteHandoff(
  principal: TeamRequestPrincipal,
  instantQuoteId: string,
): Promise<InstantQuoteHandoffLoadResult> {
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/instant-quotes/${encodeURIComponent(instantQuoteId)}`,
    );
    const payload = (await response.json().catch(() => null)) as {
      handoff?: unknown;
      message?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok) {
      return {
        ok: false,
        error: isNonEmptyString(payload?.message)
          ? payload.message
          : "The instant-quote handoff could not be verified.",
      };
    }
    if (!isValidHandoff(payload?.handoff)) {
      return {
        ok: false,
        error:
          "The instant-quote handoff returned incomplete relationship data.",
      };
    }
    return { ok: true, handoff: payload.handoff };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "The instant-quote handoff timed out. Try again."
          : "The instant-quote handoff service is unavailable. Try again.",
    };
  }
}

export function verifyInstantQuoteHandoffSelection(
  result: InstantQuoteHandoffLoadResult,
  expected: {
    instantQuoteId: string;
    contactId?: string | null;
    propertyId?: string | null;
  },
): InstantQuoteHandoffLoadResult {
  if (!result.ok) return result;
  const { handoff } = result;
  if (
    handoff.instantQuoteId !== expected.instantQuoteId ||
    (expected.contactId && handoff.contactId !== expected.contactId) ||
    (expected.propertyId && handoff.propertyId !== expected.propertyId)
  ) {
    return {
      ok: false,
      error:
        "This link does not match the quote's saved customer and property. Open the instant quote again before continuing.",
    };
  }
  return result;
}
