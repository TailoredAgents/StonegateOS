import { and, desc, eq, inArray } from "drizzle-orm";
import {
  partnerAccountLocations,
  partnerApprovalRequests,
  partnerBookingDrafts,
  partnerBookings,
} from "@/db";
import {
  buildPartnerApprovalRequestInsert,
  PartnerApprovalRuleResolutionError,
  resolvePartnerApprovalRequirement,
  type PartnerApprovalRequirementResolution,
} from "@/lib/partner-portal-v2-approvals";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MAX_APPROVAL_CANDIDATES = 100;

type QuoteApprovalTargetContext = Readonly<{
  kind: "booking" | "booking_draft";
  id: string;
  requestedByMembershipId: string;
  serviceKey: string;
  locationId: string;
  poNumber: string | null;
  costCenter: string | null;
}>;

export type PartnerQuoteApprovalEvidence = Readonly<{
  requestedByMembershipId: string;
  requestSnapshot: unknown;
  ruleSnapshot: unknown;
  requiredDecisionCount: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalCommercialString(
  commercial: Readonly<Record<string, unknown>>,
  key: "poNumber" | "costCenter",
): string | null {
  const raw = commercial[key];
  if (typeof raw !== "string") return null;
  const normalized = raw.normalize("NFKC").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function canonicalJson(value: unknown): string | null {
  function canonicalize(candidate: unknown): unknown {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TypeError("invalid_number");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (isRecord(candidate)) {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, canonicalize(candidate[key])]),
      );
    }
    throw new TypeError("invalid_json");
  }
  try {
    return JSON.stringify(canonicalize(value));
  } catch {
    return null;
  }
}

/**
 * Verifies that an approved request captured the exact canonical quote context
 * and every currently matching rule/version. Extra descriptive request fields
 * are allowed, but none of the authority-bearing selectors may be stale or
 * borrowed from another request with the same amount.
 */
export function partnerQuoteApprovalEvidenceMatches(input: {
  resolution: Extract<PartnerApprovalRequirementResolution, { required: true }>;
  target: Readonly<{
    kind: "booking" | "booking_draft";
    id: string;
    partnerAccountId: string;
  }>;
  evidence: PartnerQuoteApprovalEvidence;
}): boolean {
  if (
    input.evidence.requestedByMembershipId !==
      input.resolution.context.requestedByMembershipId ||
    input.evidence.requiredDecisionCount !==
      input.resolution.requiredDecisionCount ||
    !isRecord(input.evidence.requestSnapshot)
  ) {
    return false;
  }
  const expected = buildPartnerApprovalRequestInsert({
    resolution: input.resolution,
    target: input.target,
    now: new Date(0),
  });
  const request = input.evidence.requestSnapshot;
  const expectedRequest = expected.requestSnapshot;
  if (!isRecord(expectedRequest)) return false;
  for (const key of [
    "serviceKey",
    "locationId",
    "amountMinor",
    "currency",
    "requesterRoleKey",
    "poNumber",
    "costCenter",
  ] as const) {
    const actualValue = request[key] ?? null;
    const expectedValue = expectedRequest[key] ?? null;
    if (actualValue !== expectedValue) return false;
  }
  const actualRules = canonicalJson(input.evidence.ruleSnapshot);
  const expectedRules = canonicalJson(expected.ruleSnapshot);
  return actualRules !== null && actualRules === expectedRules;
}

async function loadTargetContext(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    bookingId: string | null;
    bookingDraftId: string | null;
  },
): Promise<QuoteApprovalTargetContext | null> {
  if (Boolean(input.bookingId) === Boolean(input.bookingDraftId)) return null;
  if (input.bookingId) {
    const [booking] = await tx
      .select({
        id: partnerBookings.id,
        requestedByMembershipId: partnerBookings.requestedByMembershipId,
        serviceKey: partnerBookings.serviceKey,
        locationId: partnerAccountLocations.id,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
      })
      .from(partnerBookings)
      .innerJoin(
        partnerAccountLocations,
        and(
          eq(
            partnerAccountLocations.partnerAccountId,
            partnerBookings.partnerAccountId,
          ),
          eq(partnerAccountLocations.propertyId, partnerBookings.propertyId),
        ),
      )
      .where(
        and(
          eq(partnerBookings.id, input.bookingId),
          eq(partnerBookings.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (
      !booking?.requestedByMembershipId ||
      !booking.serviceKey ||
      !booking.locationId
    ) {
      return null;
    }
    return {
      kind: "booking",
      id: booking.id,
      requestedByMembershipId: booking.requestedByMembershipId,
      serviceKey: booking.serviceKey,
      locationId: booking.locationId,
      poNumber: booking.poNumber,
      costCenter: booking.costCenter,
    };
  }
  const [draft] = await tx
    .select({
      id: partnerBookingDrafts.id,
      requestedByMembershipId: partnerBookingDrafts.createdByMembershipId,
      serviceKey: partnerBookingDrafts.serviceKey,
      locationId: partnerBookingDrafts.locationId,
      commercial: partnerBookingDrafts.commercial,
    })
    .from(partnerBookingDrafts)
    .innerJoin(
      partnerAccountLocations,
      and(
        eq(
          partnerAccountLocations.partnerAccountId,
          partnerBookingDrafts.partnerAccountId,
        ),
        eq(partnerAccountLocations.id, partnerBookingDrafts.locationId),
      ),
    )
    .where(
      and(
        eq(partnerBookingDrafts.id, input.bookingDraftId!),
        eq(partnerBookingDrafts.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!draft?.serviceKey || !draft.locationId) return null;
  return {
    kind: "booking_draft",
    id: draft.id,
    requestedByMembershipId: draft.requestedByMembershipId,
    serviceKey: draft.serviceKey,
    locationId: draft.locationId,
    poNumber: optionalCommercialString(draft.commercial, "poNumber"),
    costCenter: optionalCommercialString(draft.commercial, "costCenter"),
  };
}

/**
 * Canonical account-approval gate shared by Partner, public-link, and Staff
 * terminal Quote V2 acceptance. Rule matching is evaluated from the exact
 * account-owned booking/draft context. An approved request authorizes only
 * when its immutable context and complete rule/version snapshot still match.
 */
export async function partnerQuoteApprovalAllowsAcceptance(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    bookingId: string | null;
    bookingDraftId: string | null;
    totalMinCents?: number | null;
    totalMaxCents?: number | null;
    currency?: string | null;
  },
): Promise<boolean> {
  if (
    !input.currency ||
    !CURRENCY_PATTERN.test(input.currency) ||
    !Number.isSafeInteger(input.totalMinCents) ||
    !Number.isSafeInteger(input.totalMaxCents) ||
    Number(input.totalMinCents) < 0 ||
    Number(input.totalMaxCents) < Number(input.totalMinCents)
  ) {
    return false;
  }
  const target = await loadTargetContext(tx, input);
  if (!target) return false;
  const amountMinor =
    input.totalMinCents === input.totalMaxCents
      ? Number(input.totalMinCents)
      : null;
  let resolution: PartnerApprovalRequirementResolution;
  try {
    resolution = await resolvePartnerApprovalRequirement({
      tx,
      partnerAccountId: input.accountId,
      requestedByMembershipId: target.requestedByMembershipId,
      serviceKey: target.serviceKey,
      locationId: target.locationId,
      amountMinor,
      currency: input.currency,
      poNumber: target.poNumber,
      costCenter: target.costCenter,
    });
  } catch (error) {
    if (error instanceof PartnerApprovalRuleResolutionError) return false;
    throw error;
  }
  if (!resolution.required) return true;

  const approved = await tx
    .select({
      requestedByMembershipId: partnerApprovalRequests.requestedByMembershipId,
      requestSnapshot: partnerApprovalRequests.requestSnapshot,
      ruleSnapshot: partnerApprovalRequests.ruleSnapshot,
      requiredDecisionCount: partnerApprovalRequests.requiredDecisionCount,
    })
    .from(partnerApprovalRequests)
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        target.kind === "booking"
          ? eq(partnerApprovalRequests.partnerBookingId, target.id)
          : eq(partnerApprovalRequests.bookingDraftId, target.id),
        inArray(partnerApprovalRequests.state, [
          "approved",
          "approved_needs_reschedule",
        ]),
      ),
    )
    .orderBy(
      desc(partnerApprovalRequests.resolvedAt),
      desc(partnerApprovalRequests.createdAt),
    )
    .limit(MAX_APPROVAL_CANDIDATES + 1);
  // Bound evidence inspection and fail closed if the target has an anomalous
  // number of terminal approvals rather than silently ignoring older rows.
  if (approved.length > MAX_APPROVAL_CANDIDATES) return false;
  return approved.some((evidence) =>
    partnerQuoteApprovalEvidenceMatches({
      resolution,
      target: {
        kind: target.kind,
        id: target.id,
        partnerAccountId: input.accountId,
      },
      evidence,
    }),
  );
}
