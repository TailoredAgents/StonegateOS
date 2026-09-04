import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { isPartnerAddOnTierKey } from "@myst-os/pricing";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  appointmentHolds,
  appointmentNotes,
  appointments,
  auditLogs,
  calendarSyncState,
  contacts,
  getDb,
  mediaAssets,
  outboxEvents,
  partnerAccountCancellationPolicies,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountSchedulingPolicies,
  partnerAccounts,
  partnerApprovalRequests,
  partnerBookingDrafts,
  partnerBookings,
  partnerCancellationRequests,
  partnerDraftMedia,
  partnerJobEvidence,
  partnerJobEvents,
  partnerRateAddOnItems,
  partnerRescheduleRequests,
  partnerScheduleAssistanceRequests,
  partnerSchedulingProfileResourceRequirements,
  partnerSchedulingProfiles,
  partnerServiceAddOnOptions,
  partnerServiceAddOns,
  partnerServiceCatalog,
  scheduleBlocks,
  scheduleDateOverrides,
  scheduleResources,
  scheduleResourcePools,
  type DatabaseClient,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { getCalendarConfig } from "@/lib/calendar";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
  isPartnerPortalInstantConfirmationEnabled,
} from "@/lib/partner-portal-feature-flags";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import {
  DEFAULT_BOOKING_RULES_POLICY,
  DEFAULT_BUSINESS_HOURS_POLICY,
  getBookingRulesPolicy,
  getBusinessHoursPolicy,
  getPolicySetting,
  type BookingRulesPolicy,
  type BusinessHoursPolicy,
  type TimeWindow,
} from "@/lib/policy";
import { resolveOrCreateContactProperty } from "@/lib/property-write";
import {
  createSchedulePolicySnapshotFromLegacy,
  evaluateInstantConfirmEligibility,
  normalizeSchedulingReviewReasons,
  type NamedScheduleResource,
  type NamedScheduleResourceBlock,
  type NamedScheduleResourceRequirement,
  type ScheduleCapacityBlock,
  type SchedulePolicySnapshot,
  type SchedulingReviewReasonCode,
} from "@/lib/scheduling";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { narrowGlobalPartnerSchedulingPolicy } from "@/lib/partner-account-scheduling-policy";
import {
  partnerPricingStateAllowsInstantConfirmation,
  partnerPricingStateRequiresRate,
  type PartnerAccountServiceAgreementRecord,
  type PartnerAccountServiceEntitlement,
} from "@/lib/partner-account-service-agreement";
import {
  loadPartnerAgreementRateOptions,
  PartnerServiceAgreementConfigurationError,
  requirePartnerServiceEntitlement,
  type PartnerEffectiveRateOption,
} from "@/lib/partner-account-service-agreement-service";
import { queuePartnerBookingNotification } from "@/lib/partner-notification-delivery";
import {
  evaluatePartnerCancellation,
  resolvePartnerCancellationPolicy,
  resolvePersistedPartnerAccountCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";
import {
  projectPartnerAddOnSnapshots,
  resolvePartnerBookingPrice,
  type PartnerBookingPriceResolution,
  type PartnerConfiguredAddOn,
  type PartnerSelectedAddOn,
} from "@/lib/partner-portal-v2-service-add-ons";
import {
  buildPartnerApprovalRequestInsert,
  PartnerApprovalRuleResolutionError,
  resolvePartnerApprovalRequirement,
  type PartnerApprovalRequirementResolution,
} from "@/lib/partner-portal-v2-approvals";
import {
  buildPartnerJobEvidenceTransferValues,
  calendarAvailabilityReviewReasons,
  computePartnerAvailability,
  createPartnerAvailabilityScheduleDto,
  createPartnerHoldDto,
  createSubmittedPartnerBookingDto,
  evaluateCalendarCoverageState,
  evaluateDraftMediaReadiness,
  MAX_ACTIVE_PARTNER_DRAFT_MEDIA,
  partnerBookingSubmissionAppointmentSchedule,
  partnerBookingSubmissionScheduleDisposition,
  requirePartnerArrivalWindowId,
  rankPartnerAlternativeWindows,
  schedulingDemandFromProfile,
  validatePartnerBookingDraft,
  type DraftValidationResult,
  type PartnerAvailabilityResult,
  type PartnerArrivalWindowDto,
  type PartnerRankedAlternativeWindowDto,
  type PartnerDraftMutation,
  type PartnerHoldDto,
  type PartnerPreferredWindow,
  type SubmittedPartnerBookingDto,
} from "./domain";
import { PartnerPortalSchedulingError } from "./errors";

type SchedulingTransaction = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;

type DraftRow = typeof partnerBookingDrafts.$inferSelect;
type LocationRow = typeof partnerAccountLocations.$inferSelect;
type CatalogRow = typeof partnerServiceCatalog.$inferSelect;
type ProfileRow = typeof partnerSchedulingProfiles.$inferSelect;
type HoldRow = typeof appointmentHolds.$inferSelect;
type DraftMediaTransferRow = Readonly<{
  association: typeof partnerDraftMedia.$inferSelect;
  assetStatus: string;
  assetReadyAt: Date | null;
  assetDeletedAt: Date | null;
}>;

const HOLD_TTL_MINUTES = 10;
const APPROVAL_HOLD_TTL_MINUTES = 30;
const DRAFT_TTL_DAYS = 30;
const MAX_AVAILABILITY_RANGE_DAYS = 32;
const NON_BLOCKING_APPOINTMENT_STATUSES = [
  "canceled",
  "completed",
  "no_show",
] as const;

export type PartnerSchedulingActor = Readonly<{
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  sessionId: string | null;
  accessLevel: "account" | "scoped";
  canReadRates: boolean;
  locationIds: readonly string[];
  propertyIds: readonly string[];
}>;

export type PartnerDraftDto = Readonly<{
  id: string;
  rescheduleFromJobId: string | null;
  state: string;
  locationId: string | null;
  serviceKey: string | null;
  tierKey: string | null;
  selectedAddOns: readonly PartnerSelectedAddOn[];
  scope: Readonly<Record<string, unknown>>;
  description: string | null;
  crewInstructions: string | null;
  accessDetails: string | null;
  onSiteContact: Readonly<Record<string, unknown>> | null;
  proofRequirements: Readonly<Record<string, unknown>>;
  commercial: Readonly<Record<string, unknown>>;
  preferredWindows: readonly Readonly<Record<string, unknown>>[];
  scheduleAssistancePreference: "none" | "waitlist" | "callback";
  reviewReasons: readonly string[];
  validation: Readonly<Record<string, unknown>>;
  revision: number;
  expiresAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  etag: string;
}>;

export type AvailabilityDto = Readonly<{
  draft: PartnerDraftDto;
  timezone: string;
  calendar: Readonly<{
    state: "current" | "stale" | "unconfigured";
  }>;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  instantConfirmationEligible: boolean;
  windows: readonly PartnerArrivalWindowDto[];
  rankedAlternatives: readonly PartnerRankedAlternativeWindowDto[];
  pricing: PartnerAvailabilityPricingDto;
}>;

export type PartnerAvailabilityPricingDto = Readonly<{
  status:
    | "contracted"
    | "estimate"
    | "quote_required"
    | "standard_rate"
    | "review_required"
    | "hidden";
  currency: string | null;
  baseAmount: Readonly<{
    amountMinor: number;
    currency: string;
    minorUnit: 2;
  }> | null;
  addOnTotal: Readonly<{
    amountMinor: number;
    currency: string;
    minorUnit: 2;
  }> | null;
  total: Readonly<{
    amountMinor: number;
    currency: string;
    minorUnit: 2;
  }> | null;
  addOns: readonly Readonly<{
    key: string;
    label: string;
    unitLabel: string;
    quantity: number;
    requiresReview: boolean;
    unitAmount: Readonly<{
      amountMinor: number;
      currency: string;
      minorUnit: 2;
    }> | null;
    lineTotal: Readonly<{
      amountMinor: number;
      currency: string;
      minorUnit: 2;
    }> | null;
  }>[];
}>;

function availabilityMoney(
  amountMinor: number | null,
  currency: string,
): Readonly<{ amountMinor: number; currency: string; minorUnit: 2 }> | null {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor === null ||
    amountMinor < 0
  )
    return null;
  return Object.freeze({ amountMinor, currency, minorUnit: 2 as const });
}

function toPartnerAvailabilityPricingDto(
  pricing: PartnerBookingPriceResolution,
  canReadRates: boolean,
): PartnerAvailabilityPricingDto {
  const reveal = canReadRates;
  return Object.freeze({
    status: reveal ? pricing.status : "hidden",
    currency: reveal ? pricing.currency : null,
    baseAmount: reveal
      ? availabilityMoney(pricing.baseAmountMinor, pricing.currency)
      : null,
    addOnTotal: reveal
      ? availabilityMoney(pricing.addOnTotalMinor, pricing.currency)
      : null,
    total: reveal
      ? availabilityMoney(pricing.totalAmountMinor, pricing.currency)
      : null,
    addOns: Object.freeze(
      pricing.addOns.map((addOn) => ({
        key: addOn.key,
        label: addOn.label,
        unitLabel: addOn.unitLabel,
        quantity: addOn.quantity,
        requiresReview: addOn.requiresReview,
        unitAmount: reveal
          ? availabilityMoney(addOn.unitAmountMinor, pricing.currency)
          : null,
        lineTotal: reveal
          ? availabilityMoney(addOn.lineTotalMinor, pricing.currency)
          : null,
      })),
    ),
  });
}

function sha256(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\u0000", "utf8");
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function operationHash(
  kind: string,
  accountId: string,
  keyHash: string,
): string {
  return sha256("partner-portal-v2", kind, accountId, keyHash);
}

function draftRevision(row: Pick<DraftRow, "id" | "revision">): string {
  return `partner-draft:${row.id}:${row.revision}`;
}

export function toPartnerDraftDto(row: DraftRow): PartnerDraftDto {
  const publicValidation = Object.fromEntries(
    Object.entries(row.validation).filter(
      ([key]) =>
        key !== "createOperationKeyHash" && key !== "createRequestHash",
    ),
  );
  return Object.freeze({
    id: row.id,
    rescheduleFromJobId: row.rescheduleFromPartnerBookingId,
    state: row.state,
    locationId: row.locationId,
    serviceKey: row.serviceKey,
    tierKey: row.tierKey,
    selectedAddOns: Object.freeze(
      row.selectedAddOns.map((item) => ({ ...item })),
    ),
    scope: row.scope,
    description: row.description,
    crewInstructions: row.crewInstructions,
    accessDetails: row.accessDetails,
    onSiteContact: row.onSiteContact,
    proofRequirements: row.proofRequirements,
    commercial: row.commercial,
    preferredWindows: row.preferredWindows,
    scheduleAssistancePreference: row.scheduleAssistancePreference,
    reviewReasons: row.reviewReasons,
    validation: Object.freeze(publicValidation),
    revision: row.revision,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(draftRevision(row)),
  });
}

export function requirePartnerSchedulingActor(
  principal: PartnerPrincipal,
  operation: "read" | "write",
): PartnerSchedulingActor {
  if (
    !principal.accountId ||
    !principal.membershipId ||
    principal.accessSource !== "membership"
  ) {
    throw new PartnerPortalSchedulingError(
      "legacy_scope_unavailable",
      "This action requires an upgraded partner account.",
      { status: 409 },
    );
  }
  const enabled =
    operation === "read"
      ? arePartnerPortalV2ReadsEnabled(principal.accountId)
      : arePartnerPortalV2WritesEnabled(principal.accountId);
  if (!enabled) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "Partner scheduling is not enabled for this account.",
      { status: 503, retryable: false },
    );
  }
  return Object.freeze({
    accountId: principal.accountId,
    membershipId: principal.membershipId,
    partnerUserId: principal.partnerUserId,
    email: principal.email,
    sessionId: principal.session.id,
    accessLevel: principal.accessLevel,
    canReadRates:
      principal.capabilities.includes("bookings.pricing.read") ||
      principal.capabilities.includes("rates.read"),
    locationIds: Object.freeze([...(principal.accessScope.locationIds ?? [])]),
    propertyIds: Object.freeze([...(principal.accessScope.propertyIds ?? [])]),
  });
}

function assertDraftStateMutable(draft: DraftRow, now = new Date()): void {
  if (
    draft.state === "submitted" ||
    draft.state === "abandoned" ||
    draft.state === "expired"
  ) {
    throw new PartnerPortalSchedulingError(
      "conflict",
      "This saved service request can no longer be changed.",
      { status: 409 },
    );
  }
  if (draft.expiresAt && draft.expiresAt.getTime() <= now.getTime()) {
    throw new PartnerPortalSchedulingError(
      "conflict",
      "This saved service request expired. Start a new request.",
      { status: 409 },
    );
  }
}

function assertLocationAccess(
  actor: PartnerSchedulingActor,
  location: LocationRow | null,
): void {
  if (
    !location ||
    location.partnerAccountId !== actor.accountId ||
    !location.active
  ) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The service location was not found.",
      { status: 404 },
    );
  }
  if (actor.accessLevel === "account") return;
  if (actor.locationIds.includes(location.id)) return;
  if (location.propertyId && actor.propertyIds.includes(location.propertyId))
    return;
  throw new PartnerPortalSchedulingError(
    "not_found",
    "The service location was not found.",
    { status: 404 },
  );
}

function assertDraftAccess(
  actor: PartnerSchedulingActor,
  draft: DraftRow,
  location: LocationRow | null,
): void {
  if (draft.partnerAccountId !== actor.accountId) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The saved service request was not found.",
      { status: 404 },
    );
  }
  if (actor.accessLevel === "account") return;
  if (!draft.locationId) {
    if (draft.createdByMembershipId === actor.membershipId) return;
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The saved service request was not found.",
      { status: 404 },
    );
  }
  assertLocationAccess(actor, location);
}

async function loadLocation(
  tx: SchedulingTransaction,
  accountId: string,
  locationId: string | null,
): Promise<LocationRow | null> {
  if (!locationId) return null;
  const [location] = await tx
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(partnerAccountLocations.partnerAccountId, accountId),
        eq(partnerAccountLocations.id, locationId),
      ),
    )
    .limit(1);
  return location ?? null;
}

async function loadDraft(
  tx: SchedulingTransaction,
  actor: PartnerSchedulingActor,
  draftId: string,
  options: { lock?: boolean } = {},
): Promise<{ draft: DraftRow; location: LocationRow | null }> {
  const query = tx
    .select()
    .from(partnerBookingDrafts)
    .where(
      and(
        eq(partnerBookingDrafts.partnerAccountId, actor.accountId),
        eq(partnerBookingDrafts.id, draftId),
      ),
    )
    .limit(1);
  const [draft] = options.lock ? await query.for("update") : await query;
  if (!draft)
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The saved service request was not found.",
      { status: 404 },
    );
  const location = await loadLocation(tx, actor.accountId, draft.locationId);
  assertDraftAccess(actor, draft, location);
  return { draft, location };
}

function assertRevision(
  draft: DraftRow,
  ifMatch: string | null | undefined,
  correlationId: string,
): void {
  const check = evaluatePortalV2RevisionPrecondition({
    ifMatch,
    currentRevision: draftRevision(draft),
    correlationId,
  });
  if (check.ok) return;
  throw new PartnerPortalSchedulingError(
    check.response.body.error,
    check.response.body.message,
    {
      status: check.response.status,
      retryable: check.response.body.retryable,
      fieldErrors: check.response.body.fieldErrors,
      alternatives: check.response.body.alternatives,
      additionalHeaders: check.response.headers,
    },
  );
}

async function resolveMutationLocation(
  tx: SchedulingTransaction,
  actor: PartnerSchedulingActor,
  locationId: string | null | undefined,
): Promise<LocationRow | null | undefined> {
  if (locationId === undefined) return undefined;
  const location = await loadLocation(tx, actor.accountId, locationId);
  if (locationId) assertLocationAccess(actor, location);
  return location;
}

async function assertMutationService(
  tx: SchedulingTransaction,
  serviceKey: string | null | undefined,
): Promise<void> {
  if (serviceKey === undefined || serviceKey === null) return;
  const [service] = await tx
    .select({ key: partnerServiceCatalog.key })
    .from(partnerServiceCatalog)
    .where(
      and(
        eq(partnerServiceCatalog.key, serviceKey),
        eq(partnerServiceCatalog.active, true),
      ),
    )
    .limit(1);
  if (!service) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a supported service.",
      {
        status: 422,
        fieldErrors: { serviceKey: "Choose a supported service." },
      },
    );
  }
}

async function assertConfiguredSelectedAddOns(
  tx: SchedulingTransaction,
  serviceKey: string | null,
  selectedAddOns: readonly PartnerSelectedAddOn[],
): Promise<void> {
  if (selectedAddOns.length === 0) return;
  if (!serviceKey) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a base service before selecting add-ons.",
      {
        status: 422,
        fieldErrors: {
          selectedAddOns: "Choose a base service before selecting add-ons.",
        },
      },
    );
  }
  const rows = await tx
    .select({
      key: partnerServiceAddOns.key,
      minimumQuantity: partnerServiceAddOnOptions.minimumQuantity,
      maximumQuantity: partnerServiceAddOnOptions.maximumQuantity,
    })
    .from(partnerServiceAddOnOptions)
    .innerJoin(
      partnerServiceAddOns,
      eq(partnerServiceAddOns.key, partnerServiceAddOnOptions.addOnKey),
    )
    .where(
      and(
        eq(partnerServiceAddOnOptions.serviceKey, serviceKey),
        eq(partnerServiceAddOnOptions.active, true),
        eq(partnerServiceAddOns.active, true),
        inArray(
          partnerServiceAddOnOptions.addOnKey,
          selectedAddOns.map((selection) => selection.key),
        ),
      ),
    )
    .limit(selectedAddOns.length + 1);
  const configured = new Map(rows.map((row) => [row.key, row] as const));
  const invalid = selectedAddOns.find((selection) => {
    const option = configured.get(selection.key);
    return (
      !option ||
      selection.quantity < option.minimumQuantity ||
      selection.quantity > option.maximumQuantity
    );
  });
  if (invalid) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "One or more add-ons are not available for this account service.",
      {
        status: 422,
        fieldErrors: {
          selectedAddOns:
            "Choose add-ons configured for this service and valid quantities.",
        },
      },
    );
  }
}

async function assertAccountServiceTier(
  tx: SchedulingTransaction,
  accountId: string,
  serviceKey: string | null,
  tierKey: string | null,
  now: Date,
  requireComplete = false,
): Promise<void> {
  if (!serviceKey) {
    if (!tierKey) return;
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a supported base service option.",
      {
        status: 422,
        fieldErrors: { tierKey: "Choose a supported base service option." },
      },
    );
  }
  let agreement: PartnerAccountServiceAgreementRecord;
  let entitlement: PartnerAccountServiceEntitlement;
  try {
    ({ agreement, entitlement } = await requirePartnerServiceEntitlement(tx, {
      accountId,
      serviceKey,
      now,
    }));
  } catch (error) {
    if (!(error instanceof PartnerServiceAgreementConfigurationError)) {
      throw error;
    }
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "That service is not included in this account’s current agreement.",
      {
        status: 422,
        fieldErrors: {
          serviceKey: "Choose a service from this account’s current agreement.",
        },
      },
    );
  }
  if (entitlement.pricingState === "quote_required") {
    if (!tierKey) return;
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "This service requires a Stonegate quote and does not accept a rate tier.",
      { status: 422, fieldErrors: { tierKey: "Clear the base rate option." } },
    );
  }
  if (!tierKey) {
    if (!requireComplete) return;
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a base service option from this account’s current agreement.",
      {
        status: 422,
        fieldErrors: { tierKey: "Choose a current base service option." },
      },
    );
  }
  if (isPartnerAddOnTierKey(serviceKey, tierKey)) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a supported base service option.",
      { status: 422, fieldErrors: { tierKey: "Choose a base option." } },
    );
  }
  let rows: Awaited<ReturnType<typeof loadPartnerAgreementRateOptions>>;
  try {
    rows = await loadPartnerAgreementRateOptions(tx, {
      accountId,
      serviceKey,
      agreementCurrency: agreement.currency,
      now,
    });
  } catch (error) {
    if (!(error instanceof PartnerServiceAgreementConfigurationError)) {
      throw error;
    }
    rows = [];
  }
  if (rows.filter((row) => row.tierKey === tierKey).length !== 1) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "That base service option is not available for this account.",
      {
        status: 422,
        fieldErrors: {
          tierKey: "Choose a base option from this account’s service catalog.",
        },
      },
    );
  }
}

export async function createPartnerBookingDraft(input: {
  actor: PartnerSchedulingActor;
  mutation: PartnerDraftMutation;
  idempotencyKeyHash: string;
  now?: Date;
}): Promise<{ draft: PartnerDraftDto; replayed: boolean }> {
  const db = getDb();
  const now = input.now ?? new Date();
  const opHash = operationHash(
    "draft.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(stableJson(input.mutation));
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_draft_create_v2:${input.actor.accountId}`}))`,
    );
    const [replay] = await tx
      .select()
      .from(partnerBookingDrafts)
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          sql`${partnerBookingDrafts.validation}->>'createOperationKeyHash' = ${opHash}`,
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.validation["createRequestHash"] !== requestHash) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for different input.",
          { status: 409 },
        );
      }
      const replayLocation = await loadLocation(
        tx,
        input.actor.accountId,
        replay.locationId,
      );
      assertDraftAccess(input.actor, replay, replayLocation);
      return { draft: toPartnerDraftDto(replay), replayed: true };
    }
    await resolveMutationLocation(tx, input.actor, input.mutation.locationId);
    await assertMutationService(tx, input.mutation.serviceKey);
    await assertConfiguredSelectedAddOns(
      tx,
      input.mutation.serviceKey ?? null,
      input.mutation.selectedAddOns ?? [],
    );
    await assertAccountServiceTier(
      tx,
      input.actor.accountId,
      input.mutation.serviceKey ?? null,
      input.mutation.tierKey ?? null,
      now,
    );
    const [created] = await tx
      .insert(partnerBookingDrafts)
      .values({
        partnerAccountId: input.actor.accountId,
        createdByMembershipId: input.actor.membershipId,
        ...input.mutation,
        validation: {
          createOperationKeyHash: opHash,
          createRequestHash: requestHash,
          checkedAt: null,
          fieldErrors: {},
        },
        state: "draft",
        revision: 1,
        expiresAt: DateTime.fromJSDate(now)
          .plus({ days: DRAFT_TTL_DAYS })
          .toJSDate(),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("partner_draft_create_failed");
    return { draft: toPartnerDraftDto(created), replayed: false };
  });
}

function partnerJobRevision(row: {
  id: string;
  version: number;
  updatedAt: Date;
}): string {
  return `${row.id}:${row.version}:${row.updatedAt.toISOString()}`;
}

function assertPartnerJobRevision(
  row: { id: string; version: number; updatedAt: Date },
  ifMatch: string | null | undefined,
  correlationId: string,
): void {
  const check = evaluatePortalV2RevisionPrecondition({
    ifMatch,
    currentRevision: partnerJobRevision(row),
    correlationId,
  });
  if (check.ok) return;
  throw new PartnerPortalSchedulingError(
    check.response.body.error,
    check.response.body.message,
    {
      status: check.response.status,
      retryable: check.response.body.retryable,
      fieldErrors: check.response.body.fieldErrors,
      alternatives: check.response.body.alternatives,
      additionalHeaders: check.response.headers,
    },
  );
}

function snapshotRecord(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): Record<string, unknown> {
  const nested = value?.[key];
  return isRecord(nested) ? { ...nested } : {};
}

function snapshotOptionalRecord(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? { ...nested } : null;
}

function snapshotOptionalString(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

async function loadRescheduleLocation(input: {
  tx: SchedulingTransaction;
  actor: PartnerSchedulingActor;
  propertyId: string | null;
  scopeSnapshot: Readonly<Record<string, unknown>> | null;
}): Promise<LocationRow> {
  const snapshotLocationId = snapshotOptionalString(
    input.scopeSnapshot,
    "locationId",
  );
  let location = await loadLocation(
    input.tx,
    input.actor.accountId,
    snapshotLocationId,
  );
  if (!location && input.propertyId) {
    location =
      (
        await input.tx
          .select()
          .from(partnerAccountLocations)
          .where(
            and(
              eq(
                partnerAccountLocations.partnerAccountId,
                input.actor.accountId,
              ),
              eq(partnerAccountLocations.propertyId, input.propertyId),
              eq(partnerAccountLocations.active, true),
            ),
          )
          .limit(1)
      )?.[0] ?? null;
  }
  assertLocationAccess(input.actor, location ?? null);
  if (!location) throw new Error("partner_reschedule_location_missing");
  return location;
}

export async function createPartnerRescheduleDraft(input: {
  actor: PartnerSchedulingActor;
  jobId: string;
  idempotencyKeyHash: string;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<{ draft: PartnerDraftDto; replayed: boolean }> {
  const now = input.now ?? new Date();
  const opHash = operationHash(
    "reschedule.draft.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(input.jobId);

  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`partner_reschedule_draft_v2:${input.actor.accountId}`}))`,
    );

    const [source] = await tx
      .select({
        id: partnerBookings.id,
        version: partnerBookings.version,
        updatedAt: partnerBookings.updatedAt,
        publicStatus: partnerBookings.publicStatus,
        serviceKey: partnerBookings.serviceKey,
        tierKey: partnerBookings.tierKey,
        addOnsSnapshot: partnerBookings.addOnsSnapshot,
        propertyId: partnerBookings.propertyId,
        scopeSnapshot: partnerBookings.scopeSnapshot,
        proofRequirements: partnerBookings.proofRequirementsSnapshot,
        poNumber: partnerBookings.poNumber,
        costCenter: partnerBookings.costCenter,
        projectReference: partnerBookings.projectReference,
        billingContact: partnerBookings.billingContactSnapshot,
        appointmentStatus: appointments.status,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .where(
        and(
          eq(partnerBookings.partnerAccountId, input.actor.accountId),
          eq(partnerBookings.id, input.jobId),
        ),
      )
      .limit(1);
    if (!source) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The job was not found.",
        { status: 404 },
      );
    }
    const location = await loadRescheduleLocation({
      tx,
      actor: input.actor,
      propertyId: source.propertyId,
      scopeSnapshot: source.scopeSnapshot,
    });
    assertPartnerJobRevision(source, input.ifMatch, input.correlationId);
    if (
      !["requested", "approval_needed", "under_review", "confirmed"].includes(
        source.publicStatus,
      ) ||
      !["requested", "confirmed"].includes(source.appointmentStatus)
    ) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "This job can no longer be rescheduled in the portal.",
        { status: 409 },
      );
    }

    const [pendingRequest] = await tx
      .select({ id: partnerRescheduleRequests.id })
      .from(partnerRescheduleRequests)
      .where(
        and(
          eq(partnerRescheduleRequests.partnerAccountId, input.actor.accountId),
          eq(partnerRescheduleRequests.partnerBookingId, source.id),
          eq(partnerRescheduleRequests.state, "pending"),
        ),
      )
      .limit(1);
    if (pendingRequest) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "A schedule-change request is already awaiting review.",
        { status: 409 },
      );
    }
    const [pendingCancellationRequest] = await tx
      .select({ id: partnerCancellationRequests.id })
      .from(partnerCancellationRequests)
      .where(
        and(
          eq(
            partnerCancellationRequests.partnerAccountId,
            input.actor.accountId,
          ),
          eq(partnerCancellationRequests.partnerBookingId, source.id),
          eq(partnerCancellationRequests.state, "pending"),
        ),
      )
      .limit(1);
    if (pendingCancellationRequest) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "A cancellation request is awaiting review. The existing schedule remains in place until Stonegate responds.",
        { status: 409 },
      );
    }

    const activeDrafts = await tx
      .select()
      .from(partnerBookingDrafts)
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          eq(partnerBookingDrafts.rescheduleFromPartnerBookingId, source.id),
          sql`${partnerBookingDrafts.state} IN ('draft', 'ready')`,
        ),
      )
      .limit(1);
    const activeDraft = activeDrafts[0];
    if (activeDraft) {
      assertDraftAccess(input.actor, activeDraft, location);
      const storedOp =
        activeDraft.validation["rescheduleCreateOperationKeyHash"];
      const storedRequest =
        activeDraft.validation["rescheduleCreateRequestHash"];
      if (storedOp === opHash && storedRequest !== requestHash) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for different input.",
          { status: 409 },
        );
      }
      return { draft: toPartnerDraftDto(activeDraft), replayed: true };
    }

    const [created] = await tx
      .insert(partnerBookingDrafts)
      .values({
        partnerAccountId: input.actor.accountId,
        createdByMembershipId: input.actor.membershipId,
        rescheduleFromPartnerBookingId: source.id,
        locationId: location.id,
        serviceKey: source.serviceKey,
        tierKey: source.tierKey,
        selectedAddOns: projectPartnerAddOnSnapshots(source.addOnsSnapshot).map(
          (addOn) => ({ key: addOn.key, quantity: addOn.quantity }),
        ),
        state: "draft",
        scope: snapshotRecord(source.scopeSnapshot, "scope"),
        description: snapshotOptionalString(
          source.scopeSnapshot,
          "description",
        ),
        crewInstructions: snapshotOptionalString(
          source.scopeSnapshot,
          "crewInstructions",
        ),
        accessDetails: snapshotOptionalString(
          source.scopeSnapshot,
          "accessDetails",
        ),
        onSiteContact: snapshotOptionalRecord(
          source.scopeSnapshot,
          "onSiteContact",
        ),
        proofRequirements: source.proofRequirements ?? {
          before: 1,
          after: 1,
        },
        commercial: {
          ...(source.poNumber ? { poNumber: source.poNumber } : {}),
          ...(source.costCenter ? { costCenter: source.costCenter } : {}),
          ...(source.projectReference
            ? { projectReference: source.projectReference }
            : {}),
          ...(source.billingContact
            ? { billingContact: source.billingContact }
            : {}),
        },
        preferredWindows: [],
        reviewReasons: [],
        validation: {
          rescheduleCreateOperationKeyHash: opHash,
          rescheduleCreateRequestHash: requestHash,
          checkedAt: null,
          fieldErrors: {},
        },
        revision: 1,
        expiresAt: DateTime.fromJSDate(now)
          .plus({ days: DRAFT_TTL_DAYS })
          .toJSDate(),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("partner_reschedule_draft_create_failed");
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      actorRole: "partner",
      actorLabel: input.actor.email,
      sessionId: input.actor.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["bookings.update"],
      outcome: "succeeded",
      surface: `/partners/jobs/${source.id}/reschedule`,
      idempotencyKeyHash: opHash,
      action: "partner.portal.v2.reschedule.draft_created",
      entityType: "partner_booking_draft",
      entityId: created.id,
      meta: sanitizeAuditMetadata({
        accountId: input.actor.accountId,
        membershipId: input.actor.membershipId,
        partnerBookingId: source.id,
        locationId: location.id,
      }),
      createdAt: now,
    });
    return { draft: toPartnerDraftDto(created), replayed: false };
  });
}

export async function getPartnerBookingDraft(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
}): Promise<PartnerDraftDto> {
  return getDb().transaction(async (tx) => {
    const { draft } = await loadDraft(tx, input.actor, input.draftId);
    return toPartnerDraftDto(draft);
  });
}

export function partnerDraftMutationInvalidatesHold(input: {
  currentLocationId: string | null;
  currentServiceKey: string | null;
  currentTierKey?: string | null;
  currentSelectedAddOns?: readonly PartnerSelectedAddOn[];
  currentScope?: Readonly<Record<string, unknown>>;
  mutation: Pick<
    PartnerDraftMutation,
    "locationId" | "serviceKey" | "tierKey" | "selectedAddOns" | "scope"
  >;
}): boolean {
  return (
    (input.mutation.locationId !== undefined &&
      input.mutation.locationId !== input.currentLocationId) ||
    (input.mutation.serviceKey !== undefined &&
      input.mutation.serviceKey !== input.currentServiceKey) ||
    (input.mutation.tierKey !== undefined &&
      input.currentTierKey !== undefined &&
      input.mutation.tierKey !== input.currentTierKey) ||
    (input.mutation.selectedAddOns !== undefined &&
      input.currentSelectedAddOns !== undefined &&
      stableJson(input.mutation.selectedAddOns) !==
        stableJson(input.currentSelectedAddOns)) ||
    (input.mutation.scope !== undefined &&
      input.currentScope !== undefined &&
      stableJson(input.mutation.scope) !== stableJson(input.currentScope))
  );
}

export async function updatePartnerBookingDraft(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  mutation: PartnerDraftMutation;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<PartnerDraftDto> {
  const now = input.now ?? new Date();
  const mayInvalidateHold =
    input.mutation.locationId !== undefined ||
    input.mutation.serviceKey !== undefined ||
    input.mutation.tierKey !== undefined ||
    input.mutation.selectedAddOns !== undefined ||
    input.mutation.scope !== undefined;
  return getDb().transaction(async (tx) => {
    // Draft mutations can release an active hold when schedule-defining scope
    // changes. Keep the lock order consistent with hold/submit/reschedule.
    if (mayInvalidateHold) await acquireScheduleConflictLock(tx);
    const { draft } = await loadDraft(tx, input.actor, input.draftId, {
      lock: true,
    });
    assertDraftStateMutable(draft, now);
    assertRevision(draft, input.ifMatch, input.correlationId);
    await resolveMutationLocation(tx, input.actor, input.mutation.locationId);
    await assertMutationService(tx, input.mutation.serviceKey);
    const nextServiceKey =
      input.mutation.serviceKey === undefined
        ? draft.serviceKey
        : input.mutation.serviceKey;
    const nextSelectedAddOns =
      input.mutation.selectedAddOns === undefined
        ? draft.selectedAddOns
        : input.mutation.selectedAddOns;
    await assertConfiguredSelectedAddOns(
      tx,
      nextServiceKey,
      nextSelectedAddOns,
    );
    const nextTierKey =
      input.mutation.tierKey === undefined
        ? draft.tierKey
        : input.mutation.tierKey;
    await assertAccountServiceTier(
      tx,
      input.actor.accountId,
      nextServiceKey,
      nextTierKey,
      now,
    );
    if (
      partnerDraftMutationInvalidatesHold({
        currentLocationId: draft.locationId,
        currentServiceKey: draft.serviceKey,
        currentTierKey: draft.tierKey,
        currentSelectedAddOns: draft.selectedAddOns,
        currentScope: draft.scope,
        mutation: input.mutation,
      })
    ) {
      await tx
        .update(appointmentHolds)
        .set({ status: "released", updatedAt: now })
        .where(
          and(
            eq(appointmentHolds.partnerAccountId, input.actor.accountId),
            eq(appointmentHolds.partnerBookingDraftId, draft.id),
            eq(appointmentHolds.status, "active"),
          ),
        );
    }
    const [updated] = await tx
      .update(partnerBookingDrafts)
      .set({
        ...input.mutation,
        state: "draft",
        validation: {
          ...draft.validation,
          checkedAt: null,
          fieldErrors: {},
        },
        reviewReasons: [],
        revision: draft.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          eq(partnerBookingDrafts.id, draft.id),
          eq(partnerBookingDrafts.revision, draft.revision),
        ),
      )
      .returning();
    if (!updated)
      throw new PartnerPortalSchedulingError(
        "revision_mismatch",
        "This booking changed. Refresh and try again.",
        { status: 412 },
      );
    return toPartnerDraftDto(updated);
  });
}

type CalendarHealth = Readonly<{
  state: "current" | "stale" | "unconfigured";
  lastSyncedAt: Date | null;
  externalBusyCoverageSyncedAt: Date | null;
}>;

type NamedResourcePlan = Readonly<{
  resources: readonly NamedScheduleResource[];
  requirements: readonly NamedScheduleResourceRequirement[];
  revision: string;
}>;

type SchedulingSetup = Readonly<{
  catalog: CatalogRow;
  profile: ProfileRow;
  policy: SchedulePolicySnapshot;
  calendar: CalendarHealth;
  accountCommercial: AccountCommercialEligibility;
  resourcePlan: NamedResourcePlan | null;
  configurationReviewReasons: readonly SchedulingReviewReasonCode[];
}>;

type AccountContractPrice = Readonly<{
  amountMinor: number;
  currency: string;
  rateCardId: string;
  rateCardVersion: number;
  rateItemId: string;
  tierKey: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  pricingState: "contracted" | "estimate" | "standard_rate";
  agreementRevision: number;
  agreementLabel: string;
}>;

type AccountCommercialEligibility = Readonly<{
  accountStatus: string;
  approved: boolean;
  entitlement: PartnerAccountServiceEntitlement | null;
  agreement: PartnerAccountServiceAgreementRecord | null;
  contractPrice: AccountContractPrice | null;
  pricing: PartnerBookingPriceResolution;
}>;

const INSTANT_CONFIRM_ACCOUNT_STATUSES = new Set([
  "active_partner",
  "portal_partner",
  "managed_partner",
]);

export function accountStatusAllowsInstantConfirmation(
  status: string,
): boolean {
  return INSTANT_CONFIRM_ACCOUNT_STATUSES.has(status.trim().toLowerCase());
}

async function loadAccountCommercialEligibility(input: {
  tx: SchedulingTransaction;
  accountId: string;
  serviceKey: string | null;
  tierKey: string | null;
  selectedAddOns: readonly PartnerSelectedAddOn[];
  now: Date;
}): Promise<AccountCommercialEligibility> {
  const [account] = await input.tx
    .select({
      status: partnerAccounts.status,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.accountId))
    .limit(1);
  if (!account?.portalAccessEnabled) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "Partner scheduling is not enabled for this account.",
      { status: 503, retryable: false },
    );
  }

  let agreement: PartnerAccountServiceAgreementRecord | null = null;
  let entitlement: PartnerAccountServiceEntitlement | null = null;
  if (input.serviceKey) {
    try {
      ({ agreement, entitlement } = await requirePartnerServiceEntitlement(
        input.tx,
        {
          accountId: input.accountId,
          serviceKey: input.serviceKey,
          now: input.now,
        },
      ));
    } catch (error) {
      if (!(error instanceof PartnerServiceAgreementConfigurationError)) {
        throw error;
      }
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "That service is not included in this account’s active agreement.",
        {
          status: 422,
          fieldErrors: {
            serviceKey:
              "Choose a service from the current account agreement or contact Stonegate.",
          },
        },
      );
    }
  }
  let prices: readonly PartnerEffectiveRateOption[] = [];
  if (
    agreement &&
    entitlement &&
    input.serviceKey &&
    input.tierKey &&
    partnerPricingStateRequiresRate(entitlement.pricingState)
  ) {
    try {
      prices = await loadPartnerAgreementRateOptions(input.tx, {
        accountId: input.accountId,
        serviceKey: input.serviceKey,
        agreementCurrency: agreement.currency,
        now: input.now,
      });
    } catch (error) {
      if (!(error instanceof PartnerServiceAgreementConfigurationError)) {
        throw error;
      }
      throw new PartnerPortalSchedulingError(
        "review_required",
        "Account pricing cannot be verified in the agreement currency.",
        {
          status: 422,
          retryable: false,
          fieldErrors: {
            tierKey:
              "Contact Stonegate to reconcile this account’s rate card and currency.",
          },
        },
      );
    }
  }
  const price = prices.find((row) => row.tierKey === input.tierKey) ?? null;
  const currency = price?.currency.trim().toUpperCase() ?? "";
  const contractPrice =
    price &&
    agreement &&
    entitlement &&
    entitlement.pricingState !== "quote_required" &&
    Number.isSafeInteger(price.amountMinor) &&
    price.amountMinor >= 0 &&
    /^[A-Z]{3}$/u.test(currency)
      ? Object.freeze({
          ...price,
          currency,
          pricingState: entitlement.pricingState,
          agreementRevision: agreement.revision,
          agreementLabel: agreement.agreementLabel,
        })
      : null;

  await assertConfiguredSelectedAddOns(
    input.tx,
    input.serviceKey,
    input.selectedAddOns,
  );
  const configuredRows =
    input.serviceKey && input.selectedAddOns.length > 0
      ? await input.tx
          .select({
            key: partnerServiceAddOns.key,
            label: partnerServiceAddOns.label,
            unitLabel: partnerServiceAddOns.unitLabel,
            minimumQuantity: partnerServiceAddOnOptions.minimumQuantity,
            maximumQuantity: partnerServiceAddOnOptions.maximumQuantity,
            instantConfirmationMaxQuantity:
              partnerServiceAddOnOptions.instantConfirmationMaxQuantity,
            requiresReview: partnerServiceAddOnOptions.requiresReview,
          })
          .from(partnerServiceAddOnOptions)
          .innerJoin(
            partnerServiceAddOns,
            eq(partnerServiceAddOns.key, partnerServiceAddOnOptions.addOnKey),
          )
          .where(
            and(
              eq(partnerServiceAddOnOptions.serviceKey, input.serviceKey),
              eq(partnerServiceAddOnOptions.active, true),
              eq(partnerServiceAddOns.active, true),
              inArray(
                partnerServiceAddOnOptions.addOnKey,
                input.selectedAddOns.map((selection) => selection.key),
              ),
            ),
          )
          .limit(input.selectedAddOns.length + 1)
      : [];
  const priceRows =
    contractPrice && input.serviceKey && input.selectedAddOns.length > 0
      ? await input.tx
          .select({
            key: partnerRateAddOnItems.addOnKey,
            unitAmountMinor: partnerRateAddOnItems.unitAmountCents,
          })
          .from(partnerRateAddOnItems)
          .where(
            and(
              eq(partnerRateAddOnItems.rateCardId, contractPrice.rateCardId),
              eq(partnerRateAddOnItems.serviceKey, input.serviceKey),
              inArray(
                partnerRateAddOnItems.addOnKey,
                input.selectedAddOns.map((selection) => selection.key),
              ),
            ),
          )
          .limit(input.selectedAddOns.length + 1)
      : [];
  const priceByKey = new Map(
    priceRows.map((row) => [row.key, row.unitAmountMinor] as const),
  );
  const configuredAddOns: PartnerConfiguredAddOn[] = configuredRows.map(
    (row) => ({
      ...row,
      unitAmountMinor: priceByKey.get(row.key) ?? null,
      currency: contractPrice?.currency ?? null,
    }),
  );
  const pricing = resolvePartnerBookingPrice({
    baseAmountMinor: contractPrice?.amountMinor ?? null,
    baseCurrency: agreement?.currency ?? contractPrice?.currency ?? null,
    priceState: entitlement?.pricingState ?? "quote_required",
    selectedAddOns: input.selectedAddOns,
    configuredAddOns,
  });

  return Object.freeze({
    accountStatus: account.status,
    approved: accountStatusAllowsInstantConfirmation(account.status),
    entitlement,
    agreement,
    contractPrice,
    pricing,
  });
}

async function loadCatalogAndProfile(
  tx: SchedulingTransaction,
  serviceKey: string | null,
  now: Date,
): Promise<{ catalog: CatalogRow | null; profile: ProfileRow | null }> {
  if (!serviceKey) return { catalog: null, profile: null };
  const [catalog] = await tx
    .select()
    .from(partnerServiceCatalog)
    .where(eq(partnerServiceCatalog.key, serviceKey))
    .limit(1);
  const [profile] = await tx
    .select()
    .from(partnerSchedulingProfiles)
    .where(
      and(
        eq(partnerSchedulingProfiles.serviceKey, serviceKey),
        eq(partnerSchedulingProfiles.active, true),
        lte(partnerSchedulingProfiles.effectiveFrom, now),
        or(
          isNull(partnerSchedulingProfiles.effectiveTo),
          gt(partnerSchedulingProfiles.effectiveTo, now),
        ),
      ),
    )
    .orderBy(
      desc(partnerSchedulingProfiles.version),
      desc(partnerSchedulingProfiles.effectiveFrom),
    )
    .limit(1);
  return { catalog: catalog ?? null, profile: profile ?? null };
}

function configuredCalendarStaleMinutes(): number {
  const parsed = Number(
    process.env["PARTNER_PORTAL_CALENDAR_STALE_MINUTES"] ?? "15",
  );
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_440
    ? parsed
    : 15;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExplicitSchedulePolicy(
  businessHours: Readonly<Record<string, unknown>> | null,
  bookingRules: Readonly<Record<string, unknown>> | null,
): boolean {
  if (
    !businessHours ||
    typeof businessHours["timezone"] !== "string" ||
    !isRecord(businessHours["weekly"]) ||
    !bookingRules
  ) {
    return false;
  }
  const weekly = businessHours["weekly"];
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  const minute = (value: string): number => {
    if (value === "24:00") return 1_440;
    const [hour = "0", minutes = "0"] = value.split(":");
    return Number(hour) * 60 + Number(minutes);
  };
  const validWeekly = weekdays.every((weekday) => {
    const windows = weekly[weekday];
    if (!Array.isArray(windows)) return false;
    let previousEnd = -1;
    for (const window of windows) {
      if (
        !isRecord(window) ||
        typeof window["start"] !== "string" ||
        typeof window["end"] !== "string" ||
        !timePattern.test(window["start"]) ||
        (!timePattern.test(window["end"]) && window["end"] !== "24:00")
      ) {
        return false;
      }
      const start = minute(window["start"]);
      const end = minute(window["end"]);
      if (end <= start || start < previousEnd) return false;
      previousEnd = end;
    }
    return true;
  });
  if (!validWeekly) return false;
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: businessHours["timezone"],
    }).format();
  } catch {
    return false;
  }
  const inRange = (key: string, minimum: number, maximum: number) => {
    const value = bookingRules[key];
    return (
      Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum
    );
  };
  return (
    inRange("bookingWindowDays", 1, 365) &&
    inRange("bufferMinutes", 0, 1_440) &&
    inRange("maxJobsPerDay", 0, 10_000) &&
    inRange("maxJobsPerCrew", 0, 10_000)
  );
}

function normalizeBookingRulesForScheduling(
  bookingRules: BookingRulesPolicy,
): BookingRulesPolicy {
  function integerOrDefault(
    value: number,
    minimum: number,
    maximum: number,
    fallback: number,
  ): number {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum
      ? value
      : fallback;
  }
  return {
    bookingWindowDays: integerOrDefault(
      bookingRules.bookingWindowDays,
      1,
      365,
      DEFAULT_BOOKING_RULES_POLICY.bookingWindowDays,
    ),
    bufferMinutes: integerOrDefault(
      bookingRules.bufferMinutes,
      0,
      1_440,
      DEFAULT_BOOKING_RULES_POLICY.bufferMinutes,
    ),
    maxJobsPerDay: integerOrDefault(
      bookingRules.maxJobsPerDay,
      0,
      10_000,
      DEFAULT_BOOKING_RULES_POLICY.maxJobsPerDay,
    ),
    maxJobsPerCrew: integerOrDefault(
      bookingRules.maxJobsPerCrew,
      0,
      10_000,
      DEFAULT_BOOKING_RULES_POLICY.maxJobsPerCrew,
    ),
  };
}

function normalizeBusinessHoursForScheduling(
  businessHours: BusinessHoursPolicy,
): BusinessHoursPolicy {
  let timezone = businessHours.timezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    timezone = DEFAULT_BUSINESS_HOURS_POLICY.timezone;
  }
  const minute = (value: string): number | null => {
    if (value === "24:00") return 1_440;
    const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const normalizeWindows = (
    windows: readonly TimeWindow[],
    fallback: readonly TimeWindow[],
  ): TimeWindow[] => {
    const normalized = windows
      .map((window) => ({
        start: window.start.trim(),
        end: window.end.trim(),
      }))
      .sort(
        (left, right) =>
          (minute(left.start) ?? -1) - (minute(right.start) ?? -1),
      );
    let previousEnd = -1;
    for (const window of normalized) {
      const start = minute(window.start);
      const end = minute(window.end);
      if (
        start === null ||
        end === null ||
        end <= start ||
        start < previousEnd
      ) {
        return fallback.map((entry) => ({ ...entry }));
      }
      previousEnd = end;
    }
    return normalized;
  };
  return {
    timezone,
    weekly: {
      monday: normalizeWindows(
        businessHours.weekly.monday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.monday,
      ),
      tuesday: normalizeWindows(
        businessHours.weekly.tuesday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.tuesday,
      ),
      wednesday: normalizeWindows(
        businessHours.weekly.wednesday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.wednesday,
      ),
      thursday: normalizeWindows(
        businessHours.weekly.thursday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.thursday,
      ),
      friday: normalizeWindows(
        businessHours.weekly.friday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.friday,
      ),
      saturday: normalizeWindows(
        businessHours.weekly.saturday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.saturday,
      ),
      sunday: normalizeWindows(
        businessHours.weekly.sunday,
        DEFAULT_BUSINESS_HOURS_POLICY.weekly.sunday,
      ),
    },
  };
}

async function loadCalendarHealth(
  tx: SchedulingTransaction,
  now: Date,
): Promise<CalendarHealth> {
  const config = getCalendarConfig();
  if (!config) {
    return Object.freeze({
      state: "unconfigured" as const,
      lastSyncedAt: null,
      externalBusyCoverageSyncedAt: null,
    });
  }
  const [syncState] = await tx
    .select({
      lastSyncedAt: calendarSyncState.lastSyncedAt,
      lastNotificationAt: calendarSyncState.lastNotificationAt,
      externalBusyCoverageSyncedAt:
        calendarSyncState.externalBusyCoverageSyncedAt,
    })
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarId, config.calendarId))
    .limit(1);
  const lastSyncedAt = syncState?.lastSyncedAt ?? null;
  const externalBusyCoverageSyncedAt =
    syncState?.externalBusyCoverageSyncedAt ?? null;
  return Object.freeze({
    state: evaluateCalendarCoverageState({
      configured: true,
      now,
      staleMinutes: configuredCalendarStaleMinutes(),
      lastSyncedAt,
      externalBusyCoverageSyncedAt,
      lastNotificationAt: syncState?.lastNotificationAt ?? null,
    }),
    lastSyncedAt,
    externalBusyCoverageSyncedAt,
  });
}

const SCHEDULE_RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function validScheduleResourceKeys(values: readonly string[]): boolean {
  return (
    values.length <= 50 &&
    values.every(
      (value) =>
        SCHEDULE_RESOURCE_KEY_PATTERN.test(value) &&
        value === value.trim().toLowerCase(),
    ) &&
    new Set(values).size === values.length
  );
}

async function loadNamedResourcePlan(input: {
  tx: SchedulingTransaction;
  profile: ProfileRow;
}): Promise<{ plan: NamedResourcePlan | null; revision: string }> {
  const [resourceRows, requirementRows] = await Promise.all([
    input.tx
      .select()
      .from(scheduleResources)
      .where(
        eq(scheduleResources.capacityPoolKey, input.profile.capacityPoolKey),
      )
      .orderBy(
        scheduleResources.kind,
        scheduleResources.label,
        scheduleResources.id,
      ),
    input.tx
      .select()
      .from(partnerSchedulingProfileResourceRequirements)
      .where(
        eq(
          partnerSchedulingProfileResourceRequirements.schedulingProfileId,
          input.profile.id,
        ),
      )
      .orderBy(
        partnerSchedulingProfileResourceRequirements.resourceKind,
        partnerSchedulingProfileResourceRequirements.id,
      ),
  ]);
  const staffKinds = new Set(
    resourceRows
      .filter((resource) => resource.source === "staff")
      .map((resource) => resource.kind),
  );
  const selectedDefinitions = resourceRows.filter(
    (resource) => resource.source === "staff" || !staffKinds.has(resource.kind),
  );
  const resources = selectedDefinitions
    .filter((resource) => resource.active)
    .map((resource) =>
      Object.freeze({
        id: resource.id,
        capacityPoolKey: resource.capacityPoolKey,
        kind: resource.kind,
        label: resource.label,
        capacityUnits: resource.capacityUnits,
        dailyJobMultiplier:
          resource.source === "compatibility_pool" ? resource.capacityUnits : 1,
        skillKeys: Object.freeze([...resource.skillKeys]),
      }),
    );
  const requirements = requirementRows.map((requirement) =>
    Object.freeze({
      kind: requirement.resourceKind,
      quantity: requirement.quantity,
      capacityUnits: requirement.capacityUnits,
      requiredSkillKeys: Object.freeze([...requirement.requiredSkillKeys]),
    }),
  );
  const revision = sha256(
    stableJson({
      resources: resourceRows.map((resource) => ({
        id: resource.id,
        capacityPoolKey: resource.capacityPoolKey,
        kind: resource.kind,
        label: resource.label,
        capacityUnits: resource.capacityUnits,
        skillKeys: resource.skillKeys,
        active: resource.active,
        source: resource.source,
        updatedAt: resource.updatedAt.toISOString(),
      })),
      requirements: requirementRows.map((requirement) => ({
        id: requirement.id,
        kind: requirement.resourceKind,
        quantity: requirement.quantity,
        capacityUnits: requirement.capacityUnits,
        requiredSkillKeys: requirement.requiredSkillKeys,
        source: requirement.source,
        updatedAt: requirement.updatedAt.toISOString(),
      })),
    }),
  );
  const structurallyValid =
    requirements.length > 0 &&
    requirements.every(
      (requirement) =>
        validScheduleResourceKeys(requirement.requiredSkillKeys) &&
        selectedDefinitions.filter(
          (resource) =>
            resource.kind === requirement.kind &&
            resource.capacityUnits >= requirement.capacityUnits &&
            validScheduleResourceKeys(resource.skillKeys) &&
            requirement.requiredSkillKeys.every((skill) =>
              resource.skillKeys.includes(skill),
            ),
        ).length >= requirement.quantity,
    );
  return {
    plan: structurallyValid
      ? Object.freeze({
          resources: Object.freeze(resources),
          requirements: Object.freeze(requirements),
          revision,
        })
      : null,
    revision,
  };
}

async function loadSchedulePolicy(input: {
  tx: SchedulingTransaction;
  accountId: string;
  profile: ProfileRow;
  rangeStartAt: Date;
  rangeEndAt: Date;
  resourceConfigurationRevision: string;
}): Promise<{ policy: SchedulePolicySnapshot; configured: boolean }> {
  const overrideStartDate = DateTime.fromJSDate(input.rangeStartAt, {
    zone: "utc",
  })
    .minus({ days: 2 })
    .toISODate();
  const overrideEndDate = DateTime.fromJSDate(input.rangeEndAt, {
    zone: "utc",
  })
    .plus({ days: 2 })
    .toISODate();
  if (!overrideStartDate || !overrideEndDate) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a valid availability range.",
      { status: 422, fieldErrors: { range: "Choose a valid date range." } },
    );
  }
  const [
    businessHours,
    bookingRules,
    storedBusinessHours,
    storedBookingRules,
    accountPolicy,
    pool,
    overrides,
  ] = await Promise.all([
    getBusinessHoursPolicy(input.tx),
    getBookingRulesPolicy(input.tx),
    getPolicySetting(input.tx, "business_hours"),
    getPolicySetting(input.tx, "booking_rules"),
    input.tx
      .select()
      .from(partnerAccountSchedulingPolicies)
      .where(
        eq(partnerAccountSchedulingPolicies.partnerAccountId, input.accountId),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.tx
      .select()
      .from(scheduleResourcePools)
      .where(
        and(
          eq(scheduleResourcePools.key, input.profile.capacityPoolKey),
          eq(scheduleResourcePools.active, true),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.tx
      .select()
      .from(scheduleDateOverrides)
      .where(
        and(
          gte(scheduleDateOverrides.localDate, overrideStartDate),
          lte(scheduleDateOverrides.localDate, overrideEndDate),
        ),
      ),
  ]);
  if (!pool) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "Scheduling capacity is not configured for this service.",
      { status: 503, retryable: false },
    );
  }
  const safeBookingRules = normalizeBookingRulesForScheduling(bookingRules);
  const effectiveAccountPolicy = narrowGlobalPartnerSchedulingPolicy({
    global: {
      minimumNoticeMinutes: 0,
      minimumCalendarLeadDays: 1,
      maximumBookingHorizonDays: Math.min(
        30,
        safeBookingRules.bookingWindowDays,
      ),
      instantConfirmationEnabled: true,
    },
    account: accountPolicy
      ? {
          minimumNoticeMinutes: accountPolicy.minimumNoticeMinutes,
          minimumCalendarLeadDays: accountPolicy.minimumCalendarLeadDays,
          maximumBookingHorizonDays: accountPolicy.maximumBookingHorizonDays,
          instantConfirmationEnabled: accountPolicy.instantConfirmationEnabled,
        }
      : null,
  });
  // Account policy has no hours or capacity fields. It can only demand more
  // notice/lead time, shorten this horizon, or disable instant confirmation.
  const partnerBookingRules = {
    ...safeBookingRules,
    bookingWindowDays: effectiveAccountPolicy.maximumBookingHorizonDays,
  };
  const safeBusinessHours = normalizeBusinessHoursForScheduling(businessHours);
  const policyRevision = sha256(
    stableJson({
      businessHours,
      effectiveBusinessHours: safeBusinessHours,
      bookingRules,
      effectiveBookingRules: partnerBookingRules,
      accountPolicy: accountPolicy
        ? {
            partnerAccountId: accountPolicy.partnerAccountId,
            minimumNoticeMinutes: accountPolicy.minimumNoticeMinutes,
            minimumCalendarLeadDays: accountPolicy.minimumCalendarLeadDays,
            maximumBookingHorizonDays: accountPolicy.maximumBookingHorizonDays,
            instantConfirmationEnabled:
              accountPolicy.instantConfirmationEnabled,
            revision: accountPolicy.revision,
            updatedAt: accountPolicy.updatedAt.toISOString(),
          }
        : { partnerAccountId: input.accountId, configured: false },
      effectiveAccountPolicy,
      pool: {
        key: pool.key,
        capacityUnits: pool.capacityUnits,
        updatedAt: pool.updatedAt.toISOString(),
      },
      profile: {
        id: input.profile.id,
        version: input.profile.version,
        updatedAt: input.profile.updatedAt.toISOString(),
      },
      resourceConfigurationRevision: input.resourceConfigurationRevision,
      overrides: overrides.map((override) => ({
        id: override.id,
        localDate: override.localDate,
        timezone: override.timezone,
        revision: override.revision,
        updatedAt: override.updatedAt.toISOString(),
      })),
    }),
  );
  const applicableOverrides = overrides
    .filter((override) => override.timezone === safeBusinessHours.timezone)
    .map((override) => ({
      localDate: override.localDate,
      closed: override.closed,
      ...(override.windows.length > 0 ? { windows: override.windows } : {}),
      capacityByPool:
        override.capacityByPool[input.profile.capacityPoolKey] === undefined
          ? {}
          : {
              [input.profile.capacityPoolKey]:
                override.capacityByPool[input.profile.capacityPoolKey] ??
                pool.capacityUnits,
            },
    }));
  return {
    configured:
      hasExplicitSchedulePolicy(storedBusinessHours, storedBookingRules) &&
      Boolean(accountPolicy),
    policy: createSchedulePolicySnapshotFromLegacy({
      revision: policyRevision,
      businessHours: safeBusinessHours,
      bookingRules: partnerBookingRules,
      capacityUnits: pool.capacityUnits,
      capacityPoolKey: pool.key,
      dateOverrides: applicableOverrides,
      slotIntervalMinutes: 30,
      partnerWindowMinutes: 120,
      holdTtlMinutes: HOLD_TTL_MINUTES,
      channels: {
        partner_portal: {
          minimumNoticeMinutes: effectiveAccountPolicy.minimumNoticeMinutes,
          minimumCalendarLeadDays:
            effectiveAccountPolicy.minimumCalendarLeadDays,
          allowsInstantConfirmation:
            effectiveAccountPolicy.instantConfirmationEnabled,
        },
        public_quote: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        instant_quote: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        staff: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
        autonomous: {
          minimumNoticeMinutes: 0,
          minimumCalendarLeadDays: 0,
          allowsInstantConfirmation: false,
        },
      },
    }),
  };
}

async function requireSchedulingSetup(input: {
  tx: SchedulingTransaction;
  draft: DraftRow;
  rangeStartAt: Date;
  rangeEndAt: Date;
  now: Date;
}): Promise<SchedulingSetup> {
  const [{ catalog, profile }, accountCommercial] = await Promise.all([
    loadCatalogAndProfile(input.tx, input.draft.serviceKey, input.now),
    loadAccountCommercialEligibility({
      tx: input.tx,
      accountId: input.draft.partnerAccountId,
      serviceKey: input.draft.serviceKey,
      tierKey: input.draft.tierKey,
      selectedAddOns: input.draft.selectedAddOns,
      now: input.now,
    }),
  ]);
  if (!catalog?.active || !profile) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "This service is not configured for online scheduling.",
      { status: 503, retryable: false },
    );
  }
  const namedResourceConfiguration = await loadNamedResourcePlan({
    tx: input.tx,
    profile,
  });
  const [{ policy, configured }, calendar] = await Promise.all([
    loadSchedulePolicy({
      tx: input.tx,
      accountId: input.draft.partnerAccountId,
      profile,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      resourceConfigurationRevision: namedResourceConfiguration.revision,
    }),
    loadCalendarHealth(input.tx, input.now),
  ]);
  return Object.freeze({
    catalog,
    profile,
    policy,
    calendar,
    accountCommercial,
    resourcePlan: namedResourceConfiguration.plan,
    configurationReviewReasons: Object.freeze([
      ...(!configured ? (["schedule_policy_unconfigured"] as const) : []),
      ...(!namedResourceConfiguration.plan
        ? (["resource_assignment_unconfigured"] as const)
        : []),
      ...(!accountCommercial.approved
        ? (["account_approval_required"] as const)
        : []),
      ...(accountCommercial.pricing.status !== "contracted"
        ? (["rate_not_configured"] as const)
        : []),
      ...(accountCommercial.pricing.addOnReviewRequired
        ? (["manual_review_required"] as const)
        : []),
      ...calendarAvailabilityReviewReasons({
        state: calendar.state,
        externalBusyCoverageVerified:
          calendar.state === "current" &&
          calendar.externalBusyCoverageSyncedAt !== null,
      }),
    ]),
  });
}

async function validateDraftWithRows(input: {
  tx: SchedulingTransaction;
  draft: DraftRow;
  location: LocationRow | null;
  environmentalReviewReasons?: readonly SchedulingReviewReasonCode[];
  now: Date;
}): Promise<DraftValidationResult> {
  await assertConfiguredSelectedAddOns(
    input.tx,
    input.draft.serviceKey,
    input.draft.selectedAddOns,
  );
  await assertAccountServiceTier(
    input.tx,
    input.draft.partnerAccountId,
    input.draft.serviceKey,
    input.draft.tierKey,
    input.now,
    true,
  );
  const { catalog, profile } = await loadCatalogAndProfile(
    input.tx,
    input.draft.serviceKey,
    input.now,
  );
  return validatePartnerBookingDraft({
    locationId: input.draft.locationId,
    serviceKey: input.draft.serviceKey,
    scope: input.draft.scope,
    description: input.draft.description,
    onSiteContact: input.draft.onSiteContact,
    proofRequirements: input.draft.proofRequirements,
    commercial: input.draft.commercial,
    location: input.location,
    catalog,
    profile,
    environmentalReviewReasons: input.environmentalReviewReasons,
  });
}

export async function validateAndSavePartnerBookingDraft(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<{ draft: PartnerDraftDto; validation: DraftValidationResult }> {
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const { draft, location } = await loadDraft(
      tx,
      input.actor,
      input.draftId,
      { lock: true },
    );
    assertDraftStateMutable(draft, now);
    assertRevision(draft, input.ifMatch, input.correlationId);
    const validation = await validateDraftWithRows({
      tx,
      draft,
      location,
      now,
    });
    const [updated] = await tx
      .update(partnerBookingDrafts)
      .set({
        state: validation.ready ? "ready" : "draft",
        reviewReasons: [...validation.reviewReasons],
        validation: {
          ...draft.validation,
          valid: validation.valid,
          ready: validation.ready,
          fieldErrors: validation.fieldErrors,
          checkedAt: now.toISOString(),
        },
        revision: draft.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          eq(partnerBookingDrafts.id, draft.id),
          eq(partnerBookingDrafts.revision, draft.revision),
        ),
      )
      .returning();
    if (!updated)
      throw new PartnerPortalSchedulingError(
        "revision_mismatch",
        "This booking changed. Refresh and try again.",
        { status: 412 },
      );
    return { draft: toPartnerDraftDto(updated), validation };
  });
}

function assertAvailabilityRange(
  rangeStartAt: Date,
  rangeEndAt: Date,
  now: Date,
): void {
  if (
    !Number.isFinite(rangeStartAt.getTime()) ||
    !Number.isFinite(rangeEndAt.getTime()) ||
    rangeEndAt.getTime() <= rangeStartAt.getTime() ||
    rangeEndAt.getTime() - rangeStartAt.getTime() >
      MAX_AVAILABILITY_RANGE_DAYS * 86_400_000 ||
    rangeEndAt.getTime() < now.getTime() - 86_400_000
  ) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a valid availability range.",
      { status: 422, fieldErrors: { range: "Choose no more than 32 days." } },
    );
  }
}

async function loadCapacity(input: {
  tx: SchedulingTransaction;
  draft: DraftRow;
  profile: ProfileRow;
  policy: SchedulePolicySnapshot;
  rangeStartAt: Date;
  rangeEndAt: Date;
  now: Date;
}): Promise<{
  blocks: readonly ScheduleCapacityBlock[];
  resourceBlocks: readonly NamedScheduleResourceBlock[];
  ownHoldBlockIds: readonly string[];
  jobsByLocalDate: Readonly<Record<string, number>>;
}> {
  const sourceAppointmentId = input.draft.rescheduleFromPartnerBookingId
    ? await input.tx
        .select({ appointmentId: partnerBookings.appointmentId })
        .from(partnerBookings)
        .where(
          and(
            eq(partnerBookings.partnerAccountId, input.draft.partnerAccountId),
            eq(partnerBookings.id, input.draft.rescheduleFromPartnerBookingId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]?.appointmentId ?? null)
    : null;
  const [appointmentRows, holdRows, scheduleBlockRows] = await Promise.all([
    input.tx
      .select({
        id: appointments.id,
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
        capacityPoolKey: appointments.capacityPoolKey,
        capacityUnits: appointments.capacityUnits,
        resourceAssignments: appointments.resourceAssignmentSnapshot,
      })
      .from(appointments)
      .where(
        and(
          isNotNull(appointments.startAt),
          notInArray(appointments.status, [
            ...NON_BLOCKING_APPOINTMENT_STATUSES,
          ]),
          ...(sourceAppointmentId
            ? [ne(appointments.id, sourceAppointmentId)]
            : []),
          lt(appointments.startAt, input.rangeEndAt),
          sql`${appointments.startAt} + (${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute' > ${sql.param(
            input.rangeStartAt,
            appointments.startAt,
          )}`,
        ),
      ),
    input.tx
      .select({
        id: appointmentHolds.id,
        draftId: appointmentHolds.partnerBookingDraftId,
        startAt: appointmentHolds.startAt,
        durationMinutes: appointmentHolds.durationMinutes,
        travelBufferMinutes: appointmentHolds.travelBufferMinutes,
        capacityPoolKey: appointmentHolds.capacityPoolKey,
        capacityUnits: appointmentHolds.capacityUnits,
        resourceAssignments: appointmentHolds.resourceAssignmentSnapshot,
      })
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, input.now),
          lt(appointmentHolds.startAt, input.rangeEndAt),
          sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute' > ${sql.param(
            input.rangeStartAt,
            appointmentHolds.startAt,
          )}`,
        ),
      ),
    input.tx
      .select()
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.capacityPoolKey, input.profile.capacityPoolKey),
          eq(scheduleBlocks.active, true),
          lt(scheduleBlocks.startAt, input.rangeEndAt),
          gt(scheduleBlocks.endAt, input.rangeStartAt),
        ),
      ),
  ]);

  const blocks: ScheduleCapacityBlock[] = [];
  const resourceBlocks: NamedScheduleResourceBlock[] = [];
  const ownHoldBlockIds: string[] = [];
  const jobsByLocalDate: Record<string, number> = {};
  for (const row of appointmentRows) {
    if (!row.startAt) continue;
    const endAt = new Date(
      row.startAt.getTime() +
        (row.durationMinutes + row.travelBufferMinutes) * 60_000,
    );
    const id = `appointment:${row.id}`;
    blocks.push({
      id,
      kind: "appointment",
      capacityPoolKey: row.capacityPoolKey,
      capacityUnits: row.capacityUnits,
      occupancy: { startAt: row.startAt, endAt },
    });
    const localDate = DateTime.fromJSDate(row.startAt, { zone: "utc" })
      .setZone(input.policy.timezone)
      .toISODate();
    if (localDate) {
      jobsByLocalDate[localDate] = (jobsByLocalDate[localDate] ?? 0) + 1;
      for (const assignment of row.resourceAssignments) {
        resourceBlocks.push({
          id,
          resourceId: assignment.resourceId,
          capacityUnits: assignment.capacityUnits,
          occupancy: { startAt: row.startAt, endAt },
          localDate,
        });
      }
    }
  }
  for (const row of holdRows) {
    const id = `hold:${row.id}`;
    const endAt = new Date(
      row.startAt.getTime() +
        (row.durationMinutes + row.travelBufferMinutes) * 60_000,
    );
    blocks.push({
      id,
      kind: "hold",
      capacityPoolKey: row.capacityPoolKey,
      capacityUnits: row.capacityUnits,
      occupancy: { startAt: row.startAt, endAt },
    });
    const localDate = DateTime.fromJSDate(row.startAt, { zone: "utc" })
      .setZone(input.policy.timezone)
      .toISODate();
    if (localDate) {
      for (const assignment of row.resourceAssignments) {
        resourceBlocks.push({
          id,
          resourceId: assignment.resourceId,
          capacityUnits: assignment.capacityUnits,
          occupancy: { startAt: row.startAt, endAt },
          localDate,
        });
      }
    }
    if (row.draftId === input.draft.id) {
      ownHoldBlockIds.push(id);
    } else {
      if (localDate) {
        jobsByLocalDate[localDate] = (jobsByLocalDate[localDate] ?? 0) + 1;
      }
    }
  }
  const activeAppointmentIds = new Set(appointmentRows.map((row) => row.id));
  for (const row of scheduleBlockRows) {
    if (
      row.mirroredAppointmentId &&
      activeAppointmentIds.has(row.mirroredAppointmentId)
    ) {
      continue;
    }
    // capacity_adjustment has no sign/direction in the current schema. Treat
    // it as consumed capacity; inferring extra capacity could overbook.
    const kind: ScheduleCapacityBlock["kind"] =
      row.kind === "external_busy" ? "external_busy" : "blackout";
    blocks.push({
      id: `schedule-block:${row.id}`,
      kind,
      capacityPoolKey: row.capacityPoolKey,
      capacityUnits: row.capacityUnits,
      occupancy: { startAt: row.startAt, endAt: row.endAt },
    });
  }
  return {
    blocks: Object.freeze(blocks),
    resourceBlocks: Object.freeze(resourceBlocks),
    ownHoldBlockIds: Object.freeze(ownHoldBlockIds),
    jobsByLocalDate: Object.freeze(jobsByLocalDate),
  };
}

function reviewReasonsForSetup(
  validation: DraftValidationResult,
  setup: SchedulingSetup,
  draftMedia: readonly DraftMediaTransferRow[],
): readonly SchedulingReviewReasonCode[] {
  const mediaReadiness = evaluateDraftMediaReadiness(
    draftMedia.map((item) => ({
      status: item.assetStatus,
      readyAt: item.assetReadyAt,
      deletedAt: item.assetDeletedAt,
    })),
  );
  return normalizeSchedulingReviewReasons([
    ...validation.reviewReasons,
    ...setup.configurationReviewReasons,
    ...(!validation.valid ? (["availability_unverified"] as const) : []),
    ...(!mediaReadiness.readyForInstantConfirmation
      ? (["media_requires_review"] as const)
      : []),
  ]);
}

export function pricingEligibilityAllowsInstantConfirmation(
  pricingEligibility: Readonly<Record<string, unknown>>,
): boolean {
  return !(
    pricingEligibility["requiresQuote"] === true ||
    pricingEligibility["reviewRequired"] === true ||
    pricingEligibility["instantConfirmationEligible"] === false
  );
}

async function loadDraftMediaForTransfer(
  tx: SchedulingTransaction,
  accountId: string,
  draftId: string,
): Promise<readonly DraftMediaTransferRow[]> {
  const rows = await tx
    .select({
      association: partnerDraftMedia,
      assetStatus: mediaAssets.status,
      assetReadyAt: mediaAssets.readyAt,
      assetDeletedAt: mediaAssets.deletedAt,
    })
    .from(partnerDraftMedia)
    .innerJoin(mediaAssets, eq(partnerDraftMedia.mediaAssetId, mediaAssets.id))
    .where(
      and(
        eq(partnerDraftMedia.partnerAccountId, accountId),
        eq(partnerDraftMedia.bookingDraftId, draftId),
        isNull(partnerDraftMedia.deletedAt),
      ),
    )
    .orderBy(partnerDraftMedia.sortOrder, partnerDraftMedia.createdAt)
    .limit(MAX_ACTIVE_PARTNER_DRAFT_MEDIA + 1);
  evaluateDraftMediaReadiness(
    rows.map((item) => ({
      status: item.assetStatus,
      readyAt: item.assetReadyAt,
      deletedAt: item.assetDeletedAt,
    })),
  );
  return Object.freeze(rows);
}

function availabilityToDto(input: {
  draft: DraftRow;
  result: PartnerAvailabilityResult;
  setup: SchedulingSetup;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  instantConfirmationEligible: boolean;
  canReadRates: boolean;
}): AvailabilityDto {
  const schedule = createPartnerAvailabilityScheduleDto({
    timezone: input.setup.policy.timezone,
    calendarState: input.setup.calendar.state,
    reviewReasons: input.reviewReasons,
    instantConfirmationEligible: input.instantConfirmationEligible,
    windows: input.result.windows,
    rankedAlternatives: rankPartnerAlternativeWindows({
      windows: input.result.windows,
      preferredLocalDates: input.draft.preferredWindows
        .map((window) => window["localDate"])
        .filter(
          (localDate): localDate is string => typeof localDate === "string",
        ),
    }),
  });
  return Object.freeze({
    draft: toPartnerDraftDto(input.draft),
    ...schedule,
    pricing: toPartnerAvailabilityPricingDto(
      input.setup.accountCommercial.pricing,
      input.canReadRates,
    ),
  });
}

async function computeAvailabilityInTransaction(input: {
  tx: SchedulingTransaction;
  actor: PartnerSchedulingActor;
  draft: DraftRow;
  location: LocationRow | null;
  rangeStartAt: Date;
  rangeEndAt: Date;
  now: Date;
}): Promise<{
  dto: AvailabilityDto;
  setup: SchedulingSetup;
  validation: DraftValidationResult;
  result: PartnerAvailabilityResult;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  draftMedia: readonly DraftMediaTransferRow[];
}> {
  const setup = await requireSchedulingSetup({
    tx: input.tx,
    draft: input.draft,
    rangeStartAt: input.rangeStartAt,
    rangeEndAt: input.rangeEndAt,
    now: input.now,
  });
  const validation = await validateDraftWithRows({
    tx: input.tx,
    draft: input.draft,
    location: input.location,
    environmentalReviewReasons: setup.configurationReviewReasons,
    now: input.now,
  });
  const demand = schedulingDemandFromProfile(setup.profile);
  const [capacity, draftMedia] = await Promise.all([
    loadCapacity({
      tx: input.tx,
      draft: input.draft,
      profile: setup.profile,
      policy: setup.policy,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      now: input.now,
    }),
    loadDraftMediaForTransfer(input.tx, input.actor.accountId, input.draft.id),
  ]);
  const result = computePartnerAvailability({
    policy: setup.policy,
    demand,
    blocks: capacity.blocks,
    rangeStartAt: input.rangeStartAt,
    rangeEndAt: input.rangeEndAt,
    now: input.now,
    jobsByLocalDate: capacity.jobsByLocalDate,
    excludeBlockIds: capacity.ownHoldBlockIds,
    ...(setup.resourcePlan
      ? {
          resourcePlan: {
            resources: setup.resourcePlan.resources,
            requirements: setup.resourcePlan.requirements,
            blocks: capacity.resourceBlocks,
          },
        }
      : {}),
  });
  const reviewReasons = reviewReasonsForSetup(validation, setup, draftMedia);
  const eligibility = evaluateInstantConfirmEligibility({
    policyAllowsInstantConfirmation:
      setup.policy.channels.partner_portal.allowsInstantConfirmation &&
      isPartnerPortalInstantConfirmationEnabled(input.actor.accountId),
    demandAllowsInstantConfirmation:
      setup.catalog.instantBookable &&
      setup.profile.instantConfirmationEnabled &&
      Boolean(
        setup.accountCommercial.entitlement &&
          partnerPricingStateAllowsInstantConfirmation(
            setup.accountCommercial.entitlement.pricingState,
          ),
      ) &&
      pricingEligibilityAllowsInstantConfirmation(
        setup.profile.pricingEligibility,
      ),
    capacityReservation: { kind: "atomic_capacity_check" },
    reviewReasons,
    now: input.now,
  });
  return {
    dto: availabilityToDto({
      draft: input.draft,
      result,
      setup,
      reviewReasons,
      instantConfirmationEligible: eligibility.eligible,
      canReadRates: input.actor.canReadRates,
    }),
    setup,
    validation,
    result,
    reviewReasons,
    draftMedia,
  };
}

export async function getPartnerDraftAvailability(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  rangeStartAt: Date;
  rangeEndAt: Date;
  now?: Date;
}): Promise<AvailabilityDto> {
  const now = input.now ?? new Date();
  assertAvailabilityRange(input.rangeStartAt, input.rangeEndAt, now);
  return getDb().transaction(async (tx) => {
    const { draft, location } = await loadDraft(tx, input.actor, input.draftId);
    assertDraftStateMutable(draft, now);
    const availability = await computeAvailabilityInTransaction({
      tx,
      actor: input.actor,
      draft,
      location,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      now,
    });
    return availability.dto;
  });
}

function toPartnerHoldDto(hold: HoldRow): PartnerHoldDto {
  return createPartnerHoldDto({
    id: hold.id,
    draftId: hold.partnerBookingDraftId,
    status: hold.status,
    arrivalWindowStartAt: hold.arrivalWindowStartAt,
    arrivalWindowEndAt: hold.arrivalWindowEndAt,
    expiresAt: hold.expiresAt,
  });
}

function localDayRangeAround(startAt: Date): { start: Date; end: Date } {
  return {
    start: new Date(startAt.getTime() - 24 * 60 * 60_000),
    end: new Date(startAt.getTime() + 36 * 60 * 60_000),
  };
}

export async function createOrReplacePartnerHold(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  windowId: string;
  idempotencyKeyHash: string;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<{ hold: PartnerHoldDto; replayed: boolean }> {
  const now = input.now ?? new Date();
  const windowId = requirePartnerArrivalWindowId(input.windowId);
  const windowDate = DateTime.fromISO(windowId.slice(0, 10), { zone: "utc" });
  const range = {
    start: windowDate.minus({ days: 1 }).toJSDate(),
    end: windowDate.plus({ days: 2 }).toJSDate(),
  };
  const keyHash = operationHash(
    "hold.create",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  return getDb().transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const { draft, location } = await loadDraft(
      tx,
      input.actor,
      input.draftId,
      { lock: true },
    );
    assertDraftStateMutable(draft, now);
    assertRevision(draft, input.ifMatch, input.correlationId);

    const availability = await computeAvailabilityInTransaction({
      tx,
      actor: input.actor,
      draft,
      location,
      rangeStartAt: range.start,
      rangeEndAt: range.end,
      now,
    });
    if (!availability.dto.instantConfirmationEligible) {
      throw new PartnerPortalSchedulingError(
        "review_required",
        "This request needs Stonegate review. Choose preferred dates instead of reserving an arrival window.",
        {
          status: 422,
          alternatives: [
            {
              action: "request_review",
              label: "Choose preferred dates",
              href: `/partners/book?draftId=${draft.id}`,
            },
          ],
        },
      );
    }
    const window = availability.result.windows.find(
      (entry) => entry.id === windowId,
    );

    const [replay] = await tx
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.idempotencyKeyHash, keyHash),
        ),
      )
      .limit(1);
    if (replay) {
      const replayWindowId = replay.arrivalWindowStartAt
        ? DateTime.fromJSDate(replay.arrivalWindowStartAt, {
            zone: availability.setup.policy.timezone,
          }).toFormat("yyyy-MM-dd:HHmm")
        : null;
      const sameRequest =
        replay.partnerBookingDraftId === draft.id &&
        replayWindowId === windowId;
      if (!sameRequest) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for a different arrival window.",
          { status: 409 },
        );
      }
      if (
        replay.status !== "active" ||
        replay.expiresAt.getTime() <= now.getTime()
      ) {
        throw new PartnerPortalSchedulingError(
          "hold_expired",
          "This arrival-window hold expired. Choose a window again.",
          { status: 409 },
        );
      }
      return { hold: toPartnerHoldDto(replay), replayed: true };
    }

    const candidate = window?.availableCandidates[0];
    if (!window?.available || !candidate) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "That arrival window is no longer available.",
        {
          status: 409,
          alternatives: [
            {
              action: "choose_another_time",
              label: "Choose another available window",
              href: `/partners/book?draftId=${draft.id}`,
            },
          ],
        },
      );
    }

    await tx
      .update(appointmentHolds)
      .set({ status: "released", updatedAt: now })
      .where(
        and(
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.partnerBookingDraftId, draft.id),
          eq(appointmentHolds.status, "active"),
        ),
      );
    const expiresAt = new Date(now.getTime() + HOLD_TTL_MINUTES * 60_000);
    const [created] = await tx
      .insert(appointmentHolds)
      .values({
        partnerAccountId: input.actor.accountId,
        partnerBookingDraftId: draft.id,
        requestedByMembershipId: input.actor.membershipId,
        propertyId: location?.propertyId ?? null,
        startAt: candidate.startAt,
        durationMinutes: availability.setup.profile.durationMinutes,
        travelBufferMinutes: availability.setup.profile.travelBufferMinutes,
        capacityPoolKey: availability.setup.profile.capacityPoolKey,
        capacityUnits: availability.setup.profile.capacityUnits,
        arrivalWindowStartAt: window.startAt,
        arrivalWindowEndAt: window.endAt,
        policyRevision: availability.setup.policy.revision,
        serviceProfileRevision: availability.setup.profile.version,
        resourceAssignmentSnapshot: candidate.resourceAssignments.map(
          (assignment) => ({ ...assignment }),
        ),
        idempotencyKeyHash: keyHash,
        status: "active",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("partner_hold_create_failed");
    return { hold: toPartnerHoldDto(created), replayed: false };
  });
}

export async function releasePartnerHold(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  holdId?: string | null;
  now?: Date;
}): Promise<{ released: boolean }> {
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    const { draft } = await loadDraft(tx, input.actor, input.draftId);
    const predicates = [
      eq(appointmentHolds.partnerAccountId, input.actor.accountId),
      eq(appointmentHolds.partnerBookingDraftId, draft.id),
      eq(appointmentHolds.status, "active"),
    ];
    if (input.holdId) predicates.push(eq(appointmentHolds.id, input.holdId));
    const released = await tx
      .update(appointmentHolds)
      .set({ status: "released", updatedAt: now })
      .where(and(...predicates))
      .returning({ id: appointmentHolds.id });
    return { released: released.length > 0 };
  });
}

function optionalCommercialString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximum = 500,
): string | null {
  const raw = record[key];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value.slice(0, maximum) : null;
}

function sanitizedBillingContact(
  commercial: Readonly<Record<string, unknown>>,
): Readonly<{ name: string; email: string }> | null {
  const raw = commercial["billingContact"];
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Add a valid billing contact name and email.",
      {
        status: 422,
        fieldErrors: { billingContact: "Add a name and valid email." },
      },
    );
  }
  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  const email =
    typeof raw["email"] === "string" ? raw["email"].trim().toLowerCase() : "";
  if (
    Object.keys(raw).some((key) => key !== "name" && key !== "email") ||
    !name ||
    name.length > 200 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Add a valid billing contact name and email.",
      {
        status: 422,
        fieldErrors: { billingContact: "Add a name and valid email." },
      },
    );
  }
  return Object.freeze({ name, email });
}

type DraftApprovalResolution = Readonly<{
  resolution: PartnerApprovalRequirementResolution | null;
  configurationReviewRequired: boolean;
  failureCode: string | null;
}>;

async function resolveDraftApprovalRequirement(input: {
  tx: SchedulingTransaction;
  actor: PartnerSchedulingActor;
  draft: DraftRow;
  location: LocationRow;
  pricing: PartnerBookingPriceResolution;
}): Promise<DraftApprovalResolution> {
  if (!input.draft.serviceKey) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a supported service.",
      {
        status: 422,
        fieldErrors: { serviceKey: "Choose a supported service." },
      },
    );
  }
  try {
    const resolution = await resolvePartnerApprovalRequirement({
      tx: input.tx,
      partnerAccountId: input.actor.accountId,
      requestedByMembershipId: input.actor.membershipId,
      serviceKey: input.draft.serviceKey,
      locationId: input.location.id,
      amountMinor: input.pricing.totalAmountMinor,
      currency: input.pricing.currency,
      poNumber: optionalCommercialString(input.draft.commercial, "poNumber"),
      costCenter: optionalCommercialString(
        input.draft.commercial,
        "costCenter",
      ),
    });
    return Object.freeze({
      resolution,
      configurationReviewRequired: false,
      failureCode: null,
    });
  } catch (error) {
    if (!(error instanceof PartnerApprovalRuleResolutionError)) throw error;
    // A malformed or incomplete account approval configuration must never be
    // bypassed. Preserve the partner's request for staff review without
    // manufacturing an approval request from untrusted or invalid rules.
    return Object.freeze({
      resolution: null,
      configurationReviewRequired: true,
      failureCode: error.code,
    });
  }
}

function approvalRequestSnapshot(input: {
  draft: DraftRow;
  location: LocationRow;
  arrivalWindow?: Readonly<{ startAt: Date; endAt: Date }> | null;
}) {
  return Object.freeze({
    description: input.draft.description,
    notes: input.draft.crewInstructions,
    arrivalWindow: input.arrivalWindow ?? null,
    address: Object.freeze({
      line1: input.location.addressLine1,
      line2: input.location.addressLine2,
      city: input.location.city,
      state: input.location.state,
      postalCode: input.location.postalCode,
      country: "US",
    }),
  });
}

export function isReusablePartnerOperationalContact(input: {
  accountId: string;
  contact:
    | Readonly<{
        id: string;
        partnerAccountId: string | null;
        partnerStatus: string;
        deletedAt: Date | null;
      }>
    | null
    | undefined;
}): input is {
  accountId: string;
  contact: Readonly<{
    id: string;
    partnerAccountId: string;
    partnerStatus: "partner";
    deletedAt: null;
  }>;
} {
  return Boolean(
    input.contact?.id &&
      input.contact.partnerAccountId === input.accountId &&
      input.contact.partnerStatus === "partner" &&
      input.contact.deletedAt === null,
  );
}

export async function resolvePartnerBookingContactAndProperty(input: {
  tx: SchedulingTransaction;
  actor: PartnerSchedulingActor;
  location: LocationRow;
  bookingDraftId: string;
  now: Date;
}): Promise<{ contactId: string; propertyId: string }> {
  if (
    input.location.partnerAccountId !== input.actor.accountId ||
    !input.location.active
  ) {
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The service location was not found.",
      { status: 404 },
    );
  }
  const [account] = await input.tx
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      segment: partnerAccounts.segment,
      portalContactId: partnerAccounts.portalContactId,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.actor.accountId))
    .for("update")
    .limit(1);
  if (!account?.portalAccessEnabled) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "This account needs scheduling setup before a booking can be submitted.",
      { status: 503, retryable: false },
    );
  }

  const [membership] = await input.tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.id, input.actor.membershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.actor.accountId),
        eq(partnerAccountMemberships.partnerUserId, input.actor.partnerUserId),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (!membership) {
    throw new PartnerPortalSchedulingError(
      "account_access_required",
      "Your account access changed. Sign in again before submitting.",
      { status: 403, retryable: false },
    );
  }

  const [existingContact] = account.portalContactId
    ? await input.tx
        .select({
          id: contacts.id,
          partnerAccountId: contacts.partnerAccountId,
          partnerStatus: contacts.partnerStatus,
          deletedAt: contacts.deletedAt,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, account.portalContactId),
            eq(contacts.partnerAccountId, account.id),
            eq(contacts.partnerStatus, "partner"),
            isNull(contacts.deletedAt),
          ),
        )
        .limit(1)
    : [];
  let contactId = isReusablePartnerOperationalContact({
    accountId: account.id,
    contact: existingContact,
  })
    ? (existingContact?.id ?? null)
    : null;
  if (!contactId) {
    const [projection] = await input.tx
      .insert(contacts)
      .values({
        firstName: account.name,
        lastName: "Partner account",
        company: account.name,
        email: null,
        partnerAccountId: account.id,
        partnerStatus: "partner",
        partnerType: account.segment,
        partnerSince: input.now,
        source: "partner_portal_v2_projection",
      })
      .returning({ id: contacts.id });
    if (!projection)
      throw new Error("partner_operational_contact_create_failed");
    contactId = projection.id;
    await input.tx
      .update(partnerAccounts)
      .set({ portalContactId: contactId, updatedAt: input.now })
      .where(eq(partnerAccounts.id, account.id));
    await input.tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      actorRole: "partner",
      actorLabel: input.actor.email,
      sessionId: input.actor.sessionId,
      authMethod: "partner_session",
      requiredPermissions: ["bookings.create"],
      outcome: "succeeded",
      surface: "/partners/book",
      action: "partner.portal.v2.operational_contact_projected",
      entityType: "partner_account",
      entityId: account.id,
      meta: sanitizeAuditMetadata({
        accountId: account.id,
        membershipId: input.actor.membershipId,
        projectionContactId: contactId,
      }),
      createdAt: input.now,
    });
  }

  const resolved = await resolveOrCreateContactProperty(input.tx, {
    contactId,
    addressLine1: input.location.addressLine1,
    addressLine2: input.location.addressLine2,
    city: input.location.city,
    state: input.location.state,
    postalCode: input.location.postalCode,
    lat: input.location.latitude,
    lng: input.location.longitude,
    relationship: "partner_service_location",
    now: input.now,
  });
  const propertyId = resolved.property.id;
  if (input.location.propertyId !== propertyId) {
    const [updatedLocation] = await input.tx
      .update(partnerAccountLocations)
      .set({
        propertyId,
        version: input.location.version + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, input.actor.accountId),
          eq(partnerAccountLocations.id, input.location.id),
          eq(partnerAccountLocations.version, input.location.version),
        ),
      )
      .returning({ id: partnerAccountLocations.id });
    if (!updatedLocation) {
      throw new PartnerPortalSchedulingError(
        "revision_mismatch",
        "The service location changed. Refresh before submitting.",
        { status: 412 },
      );
    }
    // A hold can predate the downstream CRM property projection. Rebind that
    // same account/draft hold inside the submission transaction so a later
    // approval can prove it belongs to the submitted location.
    await input.tx
      .update(appointmentHolds)
      .set({ propertyId, updatedAt: input.now })
      .where(
        and(
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.partnerBookingDraftId, input.bookingDraftId),
          eq(appointmentHolds.status, "active"),
        ),
      );
  }
  return { contactId, propertyId };
}

function toSubmittedBookingDto(
  booking: typeof partnerBookings.$inferSelect,
): SubmittedPartnerBookingDto {
  const arrivalStart = booking.arrivalWindowStartAt;
  const arrivalEnd = booking.arrivalWindowEndAt;
  if (
    !booking.bookingDraftId ||
    Boolean(arrivalStart) !== Boolean(arrivalEnd)
  ) {
    throw new Error("partner_booking_incomplete");
  }
  return createSubmittedPartnerBookingDto({
    id: booking.id,
    draftId: booking.bookingDraftId,
    publicStatus: booking.publicStatus,
    confirmationMode: booking.confirmationMode,
    arrivalWindowStartAt: arrivalStart,
    arrivalWindowEndAt: arrivalEnd,
    reviewReasons: booking.requestedReviewReasons,
    version: booking.version,
    createdAt: booking.createdAt,
  });
}

function validatePreferredReviewWindows(input: {
  windows: readonly Readonly<Record<string, unknown>>[];
  timezone: string;
  now: Date;
}): readonly PartnerPreferredWindow[] {
  if (input.windows.length < 1 || input.windows.length > 3) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose at least one preferred date for Stonegate to review.",
      {
        status: 422,
        fieldErrors: {
          preferredWindows: "Choose one to three preferred service dates.",
        },
      },
    );
  }
  const localToday = DateTime.fromJSDate(input.now, { zone: "utc" })
    .setZone(input.timezone)
    .startOf("day");
  if (!localToday.isValid) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "This location needs a valid timezone before a request can be submitted.",
      { status: 503, retryable: false },
    );
  }
  const earliest = localToday.plus({ days: 1 });
  const latest = localToday.plus({ days: 30 });
  const seen = new Set<string>();
  const normalized: PartnerPreferredWindow[] = [];
  for (const raw of input.windows) {
    const localDate = raw["localDate"];
    const timeOfDay = raw["timeOfDay"];
    const timezone = raw["timezone"];
    const date =
      typeof localDate === "string"
        ? DateTime.fromISO(localDate, { zone: input.timezone }).startOf("day")
        : null;
    if (
      !date?.isValid ||
      date.toISODate() !== localDate ||
      date < earliest ||
      date > latest ||
      seen.has(localDate) ||
      !["morning", "afternoon", "anytime"].includes(
        typeof timeOfDay === "string" ? timeOfDay : "",
      ) ||
      timezone !== input.timezone
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Choose valid preferred dates within the next 30 days.",
        {
          status: 422,
          fieldErrors: {
            preferredWindows:
              "Choose distinct dates from tomorrow through 30 days from now.",
          },
        },
      );
    }
    seen.add(localDate);
    normalized.push(
      Object.freeze({
        localDate,
        timeOfDay: timeOfDay as PartnerPreferredWindow["timeOfDay"],
        timezone: input.timezone,
      }),
    );
  }
  return Object.freeze(normalized);
}

async function submitUnscheduledPartnerReviewRequest(input: {
  tx: SchedulingTransaction;
  actor: PartnerSchedulingActor;
  draft: DraftRow;
  location: LocationRow;
  opHash: string;
  correlationId: string;
  now: Date;
}): Promise<{ booking: SubmittedPartnerBookingDto; replayed: false }> {
  const validation = await validateDraftWithRows({
    tx: input.tx,
    draft: input.draft,
    location: input.location,
    environmentalReviewReasons: [
      "availability_unverified",
      "manual_review_required",
    ],
    now: input.now,
  });
  if (!validation.valid) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Complete the required booking details before submitting.",
      { status: 422, fieldErrors: validation.fieldErrors },
    );
  }
  const preferredWindows = validatePreferredReviewWindows({
    windows: input.draft.preferredWindows,
    timezone: input.location.timezone,
    now: input.now,
  });
  const [{ profile }, accountCommercial, draftMedia] = await Promise.all([
    loadCatalogAndProfile(input.tx, input.draft.serviceKey, input.now),
    loadAccountCommercialEligibility({
      tx: input.tx,
      accountId: input.actor.accountId,
      serviceKey: input.draft.serviceKey,
      tierKey: input.draft.tierKey,
      selectedAddOns: input.draft.selectedAddOns,
      now: input.now,
    }),
    loadDraftMediaForTransfer(input.tx, input.actor.accountId, input.draft.id),
  ]);
  const mediaReadiness = evaluateDraftMediaReadiness(
    draftMedia.map((item) => ({
      status: item.assetStatus,
      readyAt: item.assetReadyAt,
      deletedAt: item.assetDeletedAt,
    })),
  );
  const approval = await resolveDraftApprovalRequirement({
    tx: input.tx,
    actor: input.actor,
    draft: input.draft,
    location: input.location,
    pricing: accountCommercial.pricing,
  });
  const approvalResolution = approval.resolution;
  const approvalRequired = approvalResolution?.required === true;
  const reviewReasons = normalizeSchedulingReviewReasons([
    ...validation.reviewReasons,
    ...(approvalRequired ? (["account_approval_required"] as const) : []),
    ...(approval.configurationReviewRequired
      ? (["manual_review_required"] as const)
      : []),
    ...(!accountCommercial.approved
      ? (["account_approval_required"] as const)
      : []),
    ...(accountCommercial.pricing.status !== "contracted"
      ? (["rate_not_configured"] as const)
      : []),
    ...(accountCommercial.pricing.addOnReviewRequired
      ? (["manual_review_required"] as const)
      : []),
    ...(!mediaReadiness.readyForInstantConfirmation
      ? (["media_requires_review"] as const)
      : []),
    "availability_unverified",
    "manual_review_required",
  ]);
  const { contactId, propertyId } =
    await resolvePartnerBookingContactAndProperty({
      tx: input.tx,
      actor: input.actor,
      location: input.location,
      bookingDraftId: input.draft.id,
      now: input.now,
    });

  // A manual request never retains an interactive hold or claims capacity.
  await input.tx
    .update(appointmentHolds)
    .set({ status: "released", consumedAt: null, updatedAt: input.now })
    .where(
      and(
        eq(appointmentHolds.partnerAccountId, input.actor.accountId),
        eq(appointmentHolds.partnerBookingDraftId, input.draft.id),
        eq(appointmentHolds.status, "active"),
      ),
    );

  const pricing = accountCommercial.pricing;
  const contractPrice = accountCommercial.contractPrice;
  const confirmationMode = approvalRequired ? "approval" : "review";
  const publicStatus = approvalRequired ? "approval_needed" : "under_review";
  const [appointment] = await input.tx
    .insert(appointments)
    .values({
      contactId,
      propertyId,
      type: "job",
      startAt: null,
      durationMinutes: profile?.durationMinutes ?? 60,
      travelBufferMinutes: profile?.travelBufferMinutes ?? 30,
      status: "requested",
      quotedTotalCents: pricing.totalAmountMinor,
      quotedScopeText: input.draft.description,
      rescheduleToken: randomUUID().replace(/-/gu, ""),
      partnerAccountId: input.actor.accountId,
      capacityPoolKey: profile?.capacityPoolKey ?? "field_service",
      capacityUnits: profile?.capacityUnits ?? 1,
      promisedArrivalStartAt: null,
      promisedArrivalEndAt: null,
      schedulePolicyRevision: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!appointment) throw new Error("partner_review_appointment_create_failed");

  const [booking] = await input.tx
    .insert(partnerBookings)
    .values({
      orgContactId: contactId,
      partnerAccountId: input.actor.accountId,
      bookingDraftId: input.draft.id,
      requestedByMembershipId: input.actor.membershipId,
      partnerUserId: input.actor.partnerUserId,
      propertyId,
      appointmentId: appointment.id,
      serviceKey: input.draft.serviceKey,
      tierKey: input.draft.tierKey,
      amountCents: pricing.totalAmountMinor,
      currency: pricing.currency,
      publicStatus,
      confirmationMode,
      arrivalWindowStartAt: null,
      arrivalWindowEndAt: null,
      scopeSnapshot: {
        scope: input.draft.scope,
        description: input.draft.description,
        crewInstructions: input.draft.crewInstructions,
        accessDetails: input.draft.accessDetails,
        onSiteContact: input.draft.onSiteContact,
        locationId: input.location.id,
        preferredWindows,
        scheduleAssistancePreference: input.draft.scheduleAssistancePreference,
      },
      rateSnapshot: {
        amountMinor: pricing.totalAmountMinor,
        baseAmountMinor: pricing.baseAmountMinor,
        addOnTotalMinor: pricing.addOnTotalMinor,
        currency: pricing.currency,
        pricingState:
          accountCommercial.entitlement?.pricingState ?? "quote_required",
        agreementLabel: accountCommercial.agreement?.agreementLabel ?? null,
        agreementRevision: accountCommercial.agreement?.revision ?? null,
        agreementEffectiveFrom:
          accountCommercial.agreement?.effectiveFrom.toISOString() ?? null,
        agreementEffectiveTo:
          accountCommercial.agreement?.effectiveTo?.toISOString() ?? null,
        rateCardId: contractPrice?.rateCardId ?? null,
        rateCardVersion: contractPrice?.rateCardVersion ?? null,
        rateItemId: contractPrice?.rateItemId ?? null,
        tierKey: input.draft.tierKey,
        effectiveFrom: contractPrice?.effectiveFrom.toISOString() ?? null,
        effectiveTo: contractPrice?.effectiveTo?.toISOString() ?? null,
        pricingEligibility: profile?.pricingEligibility ?? null,
        serviceProfileVersion: profile?.version ?? null,
        policyRevision: null,
      },
      addOnsSnapshot: pricing.addOns.map((addOn) => ({ ...addOn })),
      proofRequirementsSnapshot: input.draft.proofRequirements,
      poNumber: optionalCommercialString(input.draft.commercial, "poNumber"),
      costCenter: optionalCommercialString(
        input.draft.commercial,
        "costCenter",
      ),
      projectReference: optionalCommercialString(
        input.draft.commercial,
        "projectReference",
      ),
      billingContactSnapshot: sanitizedBillingContact(input.draft.commercial),
      requestedReviewReasons: [...reviewReasons],
      createOperationKeyHash: input.opHash,
      createRequestHash: sha256(input.draft.id, "review"),
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!booking) throw new Error("partner_review_booking_create_failed");

  let scheduleAssistanceRequestId: string | null = null;
  if (input.draft.scheduleAssistancePreference !== "none") {
    const assistanceOperationHash = operationHash(
      "schedule.assistance",
      input.actor.accountId,
      input.opHash,
    );
    const [assistanceRequest] = await input.tx
      .insert(partnerScheduleAssistanceRequests)
      .values({
        partnerAccountId: input.actor.accountId,
        partnerBookingId: booking.id,
        bookingDraftId: input.draft.id,
        requestedByMembershipId: input.actor.membershipId,
        preference: input.draft.scheduleAssistancePreference,
        state: "pending",
        preferredWindowsSnapshot: {
          version: 1,
          windows: preferredWindows.map((window) => ({ ...window })),
        },
        operationKeyHash: assistanceOperationHash,
        requestHash: sha256(
          input.draft.id,
          booking.id,
          input.draft.scheduleAssistancePreference,
          stableJson(preferredWindows),
        ),
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: partnerScheduleAssistanceRequests.id });
    if (!assistanceRequest) {
      throw new Error("partner_schedule_assistance_create_failed");
    }
    scheduleAssistanceRequestId = assistanceRequest.id;
  }

  let approvalRequestId: string | null = null;
  if (approvalResolution?.required) {
    const [approvalRequest] = await input.tx
      .insert(partnerApprovalRequests)
      .values(
        buildPartnerApprovalRequestInsert({
          resolution: approvalResolution,
          target: {
            kind: "booking",
            id: booking.id,
            partnerAccountId: input.actor.accountId,
          },
          request: approvalRequestSnapshot({
            draft: input.draft,
            location: input.location,
          }),
          approvalHold: null,
          now: input.now,
        }),
      )
      .returning({ id: partnerApprovalRequests.id });
    if (!approvalRequest) {
      throw new Error("partner_review_approval_request_create_failed");
    }
    approvalRequestId = approvalRequest.id;
  }

  if (draftMedia.length > 0) {
    await input.tx.insert(partnerJobEvidence).values([
      ...buildPartnerJobEvidenceTransferValues({
        partnerAccountId: input.actor.accountId,
        partnerBookingId: booking.id,
        createdAt: input.now,
        associations: draftMedia.map(({ association }) => association),
      }),
    ]);
  }
  await input.tx.insert(partnerJobEvents).values({
    partnerAccountId: input.actor.accountId,
    partnerBookingId: booking.id,
    eventType: "job.submitted",
    publicLabel: approvalRequired ? "Approval requested" : "Review requested",
    publicDetail: approvalRequired
      ? "Your request was submitted for account approval. No arrival window is reserved."
      : input.draft.scheduleAssistancePreference === "waitlist"
        ? "Stonegate received your preferred dates and added this request to the scheduling waitlist. No arrival window is reserved."
        : input.draft.scheduleAssistancePreference === "callback"
          ? "Stonegate received your preferred dates and callback request. No arrival window is reserved."
          : "Stonegate received your preferred dates and will confirm availability after review.",
    effectiveAt: input.now,
    actorType: "partner",
    actorMembershipId: input.actor.membershipId,
    metadata: {
      appointmentId: appointment.id,
      approvalRequestId,
      confirmationMode,
      publicStatus,
      capacityReserved: false,
      scheduleAssistancePreference: input.draft.scheduleAssistancePreference,
    },
    createdAt: input.now,
  });
  await queuePartnerBookingNotification({
    tx: input.tx,
    accountId: input.actor.accountId,
    membershipId: input.actor.membershipId,
    partnerBookingId: booking.id,
    eventType: "booking.review_received",
    dedupeKey: input.opHash,
    correlationId: input.correlationId,
    occurredAt: input.now,
    accountTimezone: input.location.timezone,
  });
  const [submittedDraft] = await input.tx
    .update(partnerBookingDrafts)
    .set({
      state: "submitted",
      reviewReasons: [...reviewReasons],
      validation: {
        ...input.draft.validation,
        valid: true,
        ready: true,
        fieldErrors: {},
        checkedAt: input.now.toISOString(),
        bookingId: booking.id,
        schedulePromise: "none",
        scheduleAssistancePreference: input.draft.scheduleAssistancePreference,
      },
      revision: input.draft.revision + 1,
      submittedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
        eq(partnerBookingDrafts.id, input.draft.id),
        eq(partnerBookingDrafts.revision, input.draft.revision),
      ),
    )
    .returning({ id: partnerBookingDrafts.id });
  if (!submittedDraft) throw new Error("partner_review_draft_submit_failed");

  await input.tx.insert(appointmentNotes).values({
    appointmentId: appointment.id,
    body: [
      "[partner-portal-v2-review-request]",
      `Partner account: ${input.actor.accountId}`,
      `Requested by: ${input.actor.email}`,
      `Service: ${input.draft.serviceKey ?? "unspecified"}`,
      `Preferred dates: ${preferredWindows
        .map((window) => `${window.localDate} (${window.timeOfDay})`)
        .join(", ")}`,
      input.draft.scheduleAssistancePreference !== "none"
        ? `Scheduling assistance: ${input.draft.scheduleAssistancePreference}`
        : null,
      input.draft.description
        ? `Description: ${input.draft.description}`
        : null,
      input.draft.crewInstructions
        ? `Crew instructions: ${input.draft.crewInstructions}`
        : null,
      `Review reasons: ${reviewReasons.join(", ")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    createdAt: input.now,
  });
  await input.tx.insert(auditLogs).values({
    actorType: "human",
    actorId: input.actor.partnerUserId,
    actorRole: "partner",
    actorLabel: input.actor.email,
    sessionId: input.actor.sessionId,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: ["bookings.create"],
    outcome: "succeeded",
    surface: "/partners/book",
    idempotencyKeyHash: input.opHash,
    action: "partner.portal.v2.booking.review_requested",
    entityType: "partner_booking",
    entityId: booking.id,
    meta: sanitizeAuditMetadata({
      accountId: input.actor.accountId,
      membershipId: input.actor.membershipId,
      draftId: input.draft.id,
      holdId: null,
      appointmentId: appointment.id,
      propertyId,
      confirmationMode,
      publicStatus,
      capacityReserved: false,
      holdDisposition: "none",
      reviewReasons,
      preferredWindows,
      policyRevision: null,
      serviceProfileVersion: profile?.version ?? null,
      transferredDraftMediaCount: draftMedia.length,
      calendarOutboxEventId: null,
      approvalRequestId,
      approvalResolutionFailure: approval.failureCode,
      scheduleAssistancePreference: input.draft.scheduleAssistancePreference,
      scheduleAssistanceRequestId,
    }),
    createdAt: input.now,
  });
  return { booking: toSubmittedBookingDto(booking), replayed: false };
}

export async function submitPartnerBookingDraft(input: {
  actor: PartnerSchedulingActor;
  draftId: string;
  holdId: string | null;
  idempotencyKeyHash: string;
  ifMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<{ booking: SubmittedPartnerBookingDto; replayed: boolean }> {
  const now = input.now ?? new Date();
  const opHash = operationHash(
    "booking.submit",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  return getDb().transaction(async (tx) => {
    // This is intentionally the same lock as all legacy CRM booking writers.
    // It must precede capacity reads; row locks cannot prevent range phantoms.
    await acquireScheduleConflictLock(tx);

    const [replay] = await tx
      .select({ booking: partnerBookings, appointment: appointments })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .where(
        and(
          eq(partnerBookings.partnerAccountId, input.actor.accountId),
          eq(partnerBookings.createOperationKeyHash, opHash),
        ),
      )
      .limit(1);
    if (replay) {
      const replayRequestHash = sha256(input.draftId, input.holdId ?? "review");
      if (
        replay.booking.createRequestHash !== replayRequestHash ||
        replay.booking.bookingDraftId !== input.draftId
      ) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for a different booking.",
          { status: 409 },
        );
      }
      await loadDraft(tx, input.actor, input.draftId);
      return { booking: toSubmittedBookingDto(replay.booking), replayed: true };
    }

    const { draft, location } = await loadDraft(
      tx,
      input.actor,
      input.draftId,
      { lock: true },
    );
    assertDraftStateMutable(draft, now);
    assertRevision(draft, input.ifMatch, input.correlationId);
    if (!location) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Choose a service location before submitting.",
        {
          status: 422,
          fieldErrors: { locationId: "Choose a service location." },
        },
      );
    }
    const holdId = input.holdId;
    if (!holdId) {
      return submitUnscheduledPartnerReviewRequest({
        tx,
        actor: input.actor,
        draft,
        location,
        opHash,
        correlationId: input.correlationId,
        now,
      });
    }
    const [hold] = await tx
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.id, holdId),
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.partnerBookingDraftId, draft.id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !hold ||
      hold.status !== "active" ||
      hold.expiresAt.getTime() <= now.getTime() ||
      !hold.arrivalWindowStartAt ||
      !hold.arrivalWindowEndAt ||
      !hold.policyRevision ||
      hold.serviceProfileRevision === null
    ) {
      throw new PartnerPortalSchedulingError(
        "hold_expired",
        "The arrival-window hold expired. Choose a window again.",
        { status: 409 },
      );
    }

    const range = localDayRangeAround(hold.startAt);
    const availability = await computeAvailabilityInTransaction({
      tx,
      actor: input.actor,
      draft,
      location,
      rangeStartAt: range.start,
      rangeEndAt: range.end,
      now,
    });
    if (
      hold.policyRevision !== availability.setup.policy.revision ||
      hold.serviceProfileRevision !== availability.setup.profile.version ||
      hold.durationMinutes !== availability.setup.profile.durationMinutes ||
      hold.travelBufferMinutes !==
        availability.setup.profile.travelBufferMinutes ||
      hold.capacityPoolKey !== availability.setup.profile.capacityPoolKey ||
      hold.capacityUnits !== availability.setup.profile.capacityUnits
    ) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "Scheduling rules changed while this window was held. Choose a window again.",
        { status: 409 },
      );
    }
    const selectedCandidate = availability.result.candidates.find(
      (candidate) => candidate.startAt.getTime() === hold.startAt.getTime(),
    );
    if (!selectedCandidate?.available) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "That arrival window is no longer available.",
        { status: 409 },
      );
    }
    if (
      stableJson(hold.resourceAssignmentSnapshot) !==
      stableJson(selectedCandidate.resourceAssignments)
    ) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "The assigned crew or equipment changed while this window was held. Choose a window again.",
        { status: 409 },
      );
    }
    if (!availability.validation.valid) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Complete the required booking details before submitting.",
        { status: 422, fieldErrors: availability.validation.fieldErrors },
      );
    }

    const { contactId, propertyId } =
      await resolvePartnerBookingContactAndProperty({
        tx,
        actor: input.actor,
        location,
        bookingDraftId: draft.id,
        now,
      });

    const contractPrice = availability.setup.accountCommercial.contractPrice;
    const pricing = availability.setup.accountCommercial.pricing;
    const amountMinor = pricing.totalAmountMinor;
    const currency = pricing.currency;
    const approval = await resolveDraftApprovalRequirement({
      tx,
      actor: input.actor,
      draft,
      location,
      pricing,
    });
    const approvalResolution = approval.resolution;
    const approvalRequired = approvalResolution?.required === true;
    const operationalReviewReasons = normalizeSchedulingReviewReasons([
      ...availability.reviewReasons,
      ...(approval.configurationReviewRequired
        ? (["manual_review_required"] as const)
        : []),
    ]);
    const eligibility = evaluateInstantConfirmEligibility({
      policyAllowsInstantConfirmation:
        availability.setup.policy.channels.partner_portal
          .allowsInstantConfirmation &&
        isPartnerPortalInstantConfirmationEnabled(input.actor.accountId),
      demandAllowsInstantConfirmation:
        availability.setup.catalog.instantBookable &&
        availability.setup.profile.instantConfirmationEnabled &&
        Boolean(
          availability.setup.accountCommercial.entitlement &&
            partnerPricingStateAllowsInstantConfirmation(
              availability.setup.accountCommercial.entitlement.pricingState,
            ),
        ) &&
        pricingEligibilityAllowsInstantConfirmation(
          availability.setup.profile.pricingEligibility,
        ),
      capacityReservation: { kind: "active_hold", expiresAt: hold.expiresAt },
      reviewReasons: operationalReviewReasons,
      now,
    });
    const reviewReasons = normalizeSchedulingReviewReasons([
      ...operationalReviewReasons,
      ...(approvalRequired ? (["account_approval_required"] as const) : []),
    ]);
    const appointmentStatus = approvalRequired
      ? "requested"
      : eligibility.appointmentStatus;
    const confirmationMode = approvalRequired
      ? "approval"
      : eligibility.eligible
        ? "instant"
        : "review";
    const publicStatus = approvalRequired
      ? "approval_needed"
      : eligibility.eligible
        ? "confirmed"
        : "under_review";
    const requestHash = sha256(draft.id, hold.id);
    const scheduleDisposition = partnerBookingSubmissionScheduleDisposition({
      approvalRequired,
      instantConfirmationEligible: eligibility.eligible,
    });
    const appointmentSchedule = partnerBookingSubmissionAppointmentSchedule({
      disposition: scheduleDisposition,
      internalStartAt: hold.startAt,
      preferredArrivalStartAt: hold.arrivalWindowStartAt,
      preferredArrivalEndAt: hold.arrivalWindowEndAt,
      policyRevision: hold.policyRevision,
    });
    const approvalHoldExpiresAt = scheduleDisposition.retainsApprovalHold
      ? new Date(now.getTime() + APPROVAL_HOLD_TTL_MINUTES * 60_000)
      : null;

    const [transitionedHold] = await tx
      .update(appointmentHolds)
      .set({
        status: scheduleDisposition.holdStatus,
        consumedAt: scheduleDisposition.reservesCapacity ? now : null,
        expiresAt: approvalHoldExpiresAt ?? hold.expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(appointmentHolds.id, hold.id),
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, now),
        ),
      )
      .returning({
        id: appointmentHolds.id,
        expiresAt: appointmentHolds.expiresAt,
      });
    if (!transitionedHold) {
      throw new PartnerPortalSchedulingError(
        "hold_expired",
        "The arrival-window hold expired. Choose a window again.",
        { status: 409 },
      );
    }

    const [appointment] = await tx
      .insert(appointments)
      .values({
        contactId,
        propertyId,
        type: "job",
        startAt: appointmentSchedule.startAt,
        durationMinutes: hold.durationMinutes,
        travelBufferMinutes: hold.travelBufferMinutes,
        status: appointmentStatus,
        quotedTotalCents: amountMinor,
        quotedScopeText: draft.description,
        rescheduleToken: randomUUID().replace(/-/gu, ""),
        partnerAccountId: input.actor.accountId,
        capacityPoolKey: hold.capacityPoolKey,
        capacityUnits: hold.capacityUnits,
        promisedArrivalStartAt: appointmentSchedule.promisedArrivalStartAt,
        promisedArrivalEndAt: appointmentSchedule.promisedArrivalEndAt,
        schedulePolicyRevision: appointmentSchedule.schedulePolicyRevision,
        resourceAssignmentSnapshot:
          scheduleDisposition.reservesCapacity ||
          scheduleDisposition.retainsApprovalHold
            ? hold.resourceAssignmentSnapshot.map((assignment) => ({
                ...assignment,
              }))
            : [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!appointment) throw new Error("partner_appointment_create_failed");

    const [booking] = await tx
      .insert(partnerBookings)
      .values({
        orgContactId: contactId,
        partnerAccountId: input.actor.accountId,
        bookingDraftId: draft.id,
        requestedByMembershipId: input.actor.membershipId,
        partnerUserId: input.actor.partnerUserId,
        propertyId,
        appointmentId: appointment.id,
        serviceKey: draft.serviceKey,
        tierKey: draft.tierKey,
        amountCents: amountMinor,
        currency,
        publicStatus,
        confirmationMode,
        arrivalWindowStartAt: hold.arrivalWindowStartAt,
        arrivalWindowEndAt: hold.arrivalWindowEndAt,
        scopeSnapshot: {
          scope: draft.scope,
          description: draft.description,
          crewInstructions: draft.crewInstructions,
          accessDetails: draft.accessDetails,
          onSiteContact: draft.onSiteContact,
          locationId: location.id,
        },
        rateSnapshot: {
          amountMinor,
          baseAmountMinor: pricing.baseAmountMinor,
          addOnTotalMinor: pricing.addOnTotalMinor,
          currency,
          pricingState:
            availability.setup.accountCommercial.entitlement?.pricingState ??
            "quote_required",
          agreementLabel:
            availability.setup.accountCommercial.agreement?.agreementLabel ??
            null,
          agreementRevision:
            availability.setup.accountCommercial.agreement?.revision ?? null,
          agreementEffectiveFrom:
            availability.setup.accountCommercial.agreement?.effectiveFrom.toISOString() ??
            null,
          agreementEffectiveTo:
            availability.setup.accountCommercial.agreement?.effectiveTo?.toISOString() ??
            null,
          rateCardId: contractPrice?.rateCardId ?? null,
          rateCardVersion: contractPrice?.rateCardVersion ?? null,
          rateItemId: contractPrice?.rateItemId ?? null,
          tierKey: draft.tierKey,
          effectiveFrom: contractPrice?.effectiveFrom.toISOString() ?? null,
          effectiveTo: contractPrice?.effectiveTo?.toISOString() ?? null,
          pricingEligibility: availability.setup.profile.pricingEligibility,
          serviceProfileVersion: availability.setup.profile.version,
          policyRevision: availability.setup.policy.revision,
        },
        addOnsSnapshot: pricing.addOns.map((addOn) => ({ ...addOn })),
        proofRequirementsSnapshot: draft.proofRequirements,
        poNumber: optionalCommercialString(draft.commercial, "poNumber"),
        costCenter: optionalCommercialString(draft.commercial, "costCenter"),
        projectReference: optionalCommercialString(
          draft.commercial,
          "projectReference",
        ),
        billingContactSnapshot: sanitizedBillingContact(draft.commercial),
        requestedReviewReasons: [...reviewReasons],
        createOperationKeyHash: opHash,
        createRequestHash: requestHash,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!booking) throw new Error("partner_booking_create_failed");

    let approvalRequestId: string | null = null;
    if (approvalResolution?.required) {
      const [approvalRequest] = await tx
        .insert(partnerApprovalRequests)
        .values(
          buildPartnerApprovalRequestInsert({
            resolution: approvalResolution,
            target: {
              kind: "booking",
              id: booking.id,
              partnerAccountId: input.actor.accountId,
            },
            request: approvalRequestSnapshot({
              draft,
              location,
              arrivalWindow: {
                startAt: hold.arrivalWindowStartAt,
                endAt: hold.arrivalWindowEndAt,
              },
            }),
            approvalHold: scheduleDisposition.retainsApprovalHold
              ? {
                  id: transitionedHold.id,
                  partnerAccountId: input.actor.accountId,
                  expiresAt: transitionedHold.expiresAt,
                }
              : null,
            now,
          }),
        )
        .returning({ id: partnerApprovalRequests.id });
      if (!approvalRequest) {
        throw new Error("partner_approval_request_create_failed");
      }
      approvalRequestId = approvalRequest.id;
    }

    if (availability.draftMedia.length > 0) {
      await tx.insert(partnerJobEvidence).values([
        ...buildPartnerJobEvidenceTransferValues({
          partnerAccountId: input.actor.accountId,
          partnerBookingId: booking.id,
          createdAt: now,
          associations: availability.draftMedia.map(
            ({ association }) => association,
          ),
        }),
      ]);
    }

    await tx.insert(partnerJobEvents).values({
      partnerAccountId: input.actor.accountId,
      partnerBookingId: booking.id,
      eventType: "job.submitted",
      publicLabel: scheduleDisposition.reservesCapacity
        ? "Booking confirmed"
        : approvalRequired
          ? "Approval requested"
          : "Booking received",
      publicDetail: scheduleDisposition.reservesCapacity
        ? "Your two-hour arrival window is confirmed."
        : approvalRequired
          ? scheduleDisposition.retainsApprovalHold
            ? "Your requested window is held for 30 minutes while your account reviews the request. It is not confirmed until approval is complete."
            : "Your request was submitted for account approval, but no arrival window is reserved."
          : "Your request was submitted and is being reviewed.",
      effectiveAt: now,
      actorType: "partner",
      actorMembershipId: input.actor.membershipId,
      metadata: {
        appointmentId: appointment.id,
        approvalRequestId,
        approvalHoldExpiresAt: approvalHoldExpiresAt?.toISOString() ?? null,
        confirmationMode,
        publicStatus,
      },
      createdAt: now,
    });
    await queuePartnerBookingNotification({
      tx,
      accountId: input.actor.accountId,
      membershipId: input.actor.membershipId,
      partnerBookingId: booking.id,
      eventType: scheduleDisposition.reservesCapacity
        ? "booking.created"
        : "booking.review_received",
      dedupeKey: opHash,
      correlationId: input.correlationId,
      occurredAt: now,
      accountTimezone: location.timezone,
      serviceAt: hold.arrivalWindowStartAt,
    });

    const [submittedDraft] = await tx
      .update(partnerBookingDrafts)
      .set({
        state: "submitted",
        reviewReasons: [...reviewReasons],
        validation: {
          ...draft.validation,
          valid: true,
          ready: true,
          fieldErrors: {},
          checkedAt: now.toISOString(),
          bookingId: booking.id,
        },
        revision: draft.revision + 1,
        submittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          eq(partnerBookingDrafts.id, draft.id),
          eq(partnerBookingDrafts.revision, draft.revision),
        ),
      )
      .returning({ id: partnerBookingDrafts.id });
    if (!submittedDraft) throw new Error("partner_draft_submit_failed");

    await tx.insert(appointmentNotes).values({
      appointmentId: appointment.id,
      body: [
        "[partner-portal-v2-booking]",
        `Partner account: ${input.actor.accountId}`,
        `Requested by: ${input.actor.email}`,
        `Service: ${draft.serviceKey ?? "unspecified"}`,
        pricing.addOns.length > 0
          ? `Add-ons: ${pricing.addOns
              .map((addOn) => `${addOn.label} × ${addOn.quantity}`)
              .join(", ")}`
          : null,
        draft.description ? `Description: ${draft.description}` : null,
        draft.crewInstructions
          ? `Crew instructions: ${draft.crewInstructions}`
          : null,
        reviewReasons.length > 0
          ? `Review reasons: ${reviewReasons.join(", ")}`
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      createdAt: now,
    });
    const calendarOutbox = scheduleDisposition.reservesCapacity
      ? await tx
          .insert(outboxEvents)
          .values({
            type: "appointment.calendar_sync_requested",
            payload: {
              appointmentId: appointment.id,
              version: appointment.updatedAt.toISOString(),
              reason: "partner.portal.v2.booking.submitted",
              requestedCalendarEventId: null,
              correlationId: input.correlationId,
            },
            createdAt: now,
          })
          .returning({ id: outboxEvents.id })
          .then((rows) => rows[0] ?? null)
      : null;
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      actorRole: "partner",
      actorLabel: input.actor.email,
      sessionId: input.actor.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["bookings.create"],
      outcome: "succeeded",
      surface: "/partners/book",
      idempotencyKeyHash: opHash,
      action: "partner.portal.v2.booking.submitted",
      entityType: "partner_booking",
      entityId: booking.id,
      meta: sanitizeAuditMetadata({
        accountId: input.actor.accountId,
        membershipId: input.actor.membershipId,
        draftId: draft.id,
        holdId: hold.id,
        appointmentId: appointment.id,
        propertyId,
        confirmationMode,
        publicStatus,
        capacityReserved: scheduleDisposition.reservesCapacity,
        approvalHoldRetained: scheduleDisposition.retainsApprovalHold,
        holdDisposition: scheduleDisposition.holdStatus,
        approvalRequestId,
        approvalResolutionFailure: approval.failureCode,
        reviewReasons,
        policyRevision: availability.setup.policy.revision,
        serviceProfileVersion: availability.setup.profile.version,
        calendarState: availability.setup.calendar.state,
        transferredDraftMediaCount: availability.draftMedia.length,
        calendarOutboxEventId: calendarOutbox?.id ?? null,
      }),
      createdAt: now,
    });
    return {
      booking: toSubmittedBookingDto(booking),
      replayed: false,
    };
  });
}

export type PartnerRescheduleResultDto = Readonly<{
  mode: "instant" | "review";
  jobId: string;
  requestId: string | null;
  publicStatus: string;
  arrivalWindowStartAt: string;
  arrivalWindowEndAt: string;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  version: number;
  updatedAt: string;
  etag: string;
  consequence: Readonly<{
    existingScheduleRemainsInPlace: boolean;
    automaticFeeMinor: null;
    label: string;
  }>;
}>;

export function createPartnerRescheduleResultDto(input: {
  mode: "instant" | "review";
  requestId?: string | null;
  booking: {
    id: string;
    publicStatus: string;
    requestedReviewReasons: readonly string[];
    version: number;
    updatedAt: Date;
    arrivalWindowStartAt: Date | null;
    arrivalWindowEndAt: Date | null;
  };
  requestedArrivalWindow?: {
    startAt: Date;
    endAt: Date;
  };
  reviewReasons?: readonly SchedulingReviewReasonCode[];
}): PartnerRescheduleResultDto {
  const arrivalWindowStartAt =
    input.requestedArrivalWindow?.startAt ?? input.booking.arrivalWindowStartAt;
  const arrivalWindowEndAt =
    input.requestedArrivalWindow?.endAt ?? input.booking.arrivalWindowEndAt;
  if (!arrivalWindowStartAt || !arrivalWindowEndAt) {
    throw new Error("partner_reschedule_result_incomplete");
  }
  return Object.freeze({
    mode: input.mode,
    jobId: input.booking.id,
    requestId: input.requestId ?? null,
    publicStatus: input.booking.publicStatus,
    arrivalWindowStartAt: arrivalWindowStartAt.toISOString(),
    arrivalWindowEndAt: arrivalWindowEndAt.toISOString(),
    reviewReasons: Object.freeze(
      input.reviewReasons ??
        normalizeSchedulingReviewReasons(input.booking.requestedReviewReasons),
    ),
    version: input.booking.version,
    updatedAt: input.booking.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(partnerJobRevision(input.booking)),
    consequence: Object.freeze({
      existingScheduleRemainsInPlace: input.mode === "review",
      automaticFeeMinor: null,
      label:
        input.mode === "review"
          ? "The requested window is awaiting staff review. The existing schedule remains in place and no fee is applied automatically."
          : "The new arrival window is confirmed. No fee is applied automatically.",
    }),
  });
}

export async function reschedulePartnerBooking(input: {
  actor: PartnerSchedulingActor;
  jobId: string;
  draftId: string;
  holdId: string;
  idempotencyKeyHash: string;
  jobIfMatch: string | null | undefined;
  draftIfMatch: string | null | undefined;
  correlationId: string;
  now?: Date;
}): Promise<{ result: PartnerRescheduleResultDto; replayed: boolean }> {
  const now = input.now ?? new Date();
  const opHash = operationHash(
    "booking.reschedule",
    input.actor.accountId,
    input.idempotencyKeyHash,
  );
  const requestHash = sha256(input.jobId, input.draftId, input.holdId);

  return getDb().transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);

    const [source] = await tx
      .select({
        booking: partnerBookings,
        appointment: appointments,
        accountPortalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .innerJoin(
        partnerAccounts,
        eq(partnerBookings.partnerAccountId, partnerAccounts.id),
      )
      .where(
        and(
          eq(partnerBookings.partnerAccountId, input.actor.accountId),
          eq(partnerBookings.id, input.jobId),
        ),
      )
      .for("update")
      .limit(1);
    if (!source) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The job was not found.",
        { status: 404 },
      );
    }
    const location = await loadRescheduleLocation({
      tx,
      actor: input.actor,
      propertyId: source.booking.propertyId,
      scopeSnapshot: source.booking.scopeSnapshot,
    });

    if (source.booking.rescheduleOperationKeyHash === opHash) {
      if (source.booking.rescheduleRequestHash !== requestHash) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for a different schedule change.",
          { status: 409 },
        );
      }
      return {
        result: createPartnerRescheduleResultDto({
          mode: "instant",
          booking: source.booking,
        }),
        replayed: true,
      };
    }

    const [reviewReplay] = await tx
      .select()
      .from(partnerRescheduleRequests)
      .where(
        and(
          eq(partnerRescheduleRequests.partnerAccountId, input.actor.accountId),
          eq(partnerRescheduleRequests.operationKeyHash, opHash),
        ),
      )
      .limit(1);
    if (reviewReplay) {
      if (
        reviewReplay.requestHash !== requestHash ||
        reviewReplay.partnerBookingId !== source.booking.id ||
        reviewReplay.bookingDraftId !== input.draftId
      ) {
        throw new PartnerPortalSchedulingError(
          "idempotency_conflict",
          "That request key was already used for a different schedule change.",
          { status: 409 },
        );
      }
      return {
        result: createPartnerRescheduleResultDto({
          mode: "review",
          requestId: reviewReplay.id,
          booking: source.booking,
          requestedArrivalWindow: {
            startAt: reviewReplay.requestedArrivalStartAt,
            endAt: reviewReplay.requestedArrivalEndAt,
          },
          reviewReasons: normalizeSchedulingReviewReasons(
            reviewReplay.reviewReasons,
          ),
        }),
        replayed: true,
      };
    }

    const [pendingCancellationRequest] = await tx
      .select({ id: partnerCancellationRequests.id })
      .from(partnerCancellationRequests)
      .where(
        and(
          eq(
            partnerCancellationRequests.partnerAccountId,
            input.actor.accountId,
          ),
          eq(partnerCancellationRequests.partnerBookingId, source.booking.id),
          eq(partnerCancellationRequests.state, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (pendingCancellationRequest) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "A cancellation request is awaiting review. The existing schedule remains in place until Stonegate responds.",
        { status: 409 },
      );
    }

    assertPartnerJobRevision(
      source.booking,
      input.jobIfMatch,
      input.correlationId,
    );
    if (
      !["requested", "approval_needed", "under_review", "confirmed"].includes(
        source.booking.publicStatus,
      ) ||
      !["requested", "confirmed"].includes(source.appointment.status) ||
      !source.appointment.startAt
    ) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "This job can no longer be rescheduled in the portal.",
        { status: 409 },
      );
    }
    const [cancellationPolicyRow] = await tx
      .select()
      .from(partnerAccountCancellationPolicies)
      .where(
        eq(
          partnerAccountCancellationPolicies.partnerAccountId,
          input.actor.accountId,
        ),
      )
      .limit(1);
    const cancellationPolicy = resolvePartnerCancellationPolicy({
      timezone: location.timezone,
      accountPolicy: resolvePersistedPartnerAccountCancellationPolicy(
        cancellationPolicyRow ?? null,
      ),
    });
    const scheduleChangePolicyDecision = evaluatePartnerCancellation({
      status: source.booking.publicStatus,
      promisedArrivalStartAt: source.booking.arrivalWindowStartAt,
      now,
      canCancel: true,
      reviewPending: false,
      policy: cancellationPolicy,
    });
    const scheduleChangePolicyRequiresReview =
      source.booking.publicStatus === "confirmed" &&
      scheduleChangePolicyDecision.action === "request_cancellation_review";

    const { draft } = await loadDraft(tx, input.actor, input.draftId, {
      lock: true,
    });
    assertDraftStateMutable(draft, now);
    assertRevision(draft, input.draftIfMatch, input.correlationId);
    if (draft.rescheduleFromPartnerBookingId !== source.booking.id) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The schedule-change draft was not found.",
        { status: 404 },
      );
    }

    const [hold] = await tx
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.id, input.holdId),
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.partnerBookingDraftId, draft.id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !hold ||
      hold.status !== "active" ||
      hold.expiresAt.getTime() <= now.getTime() ||
      !hold.arrivalWindowStartAt ||
      !hold.arrivalWindowEndAt
    ) {
      throw new PartnerPortalSchedulingError(
        "hold_expired",
        "The arrival-window hold expired. Choose a window again.",
        { status: 410 },
      );
    }

    const range = localDayRangeAround(hold.startAt);
    const availability = await computeAvailabilityInTransaction({
      tx,
      actor: input.actor,
      draft,
      location,
      rangeStartAt: range.start,
      rangeEndAt: range.end,
      now,
    });
    if (
      hold.policyRevision !== availability.setup.policy.revision ||
      hold.serviceProfileRevision !== availability.setup.profile.version ||
      hold.durationMinutes !== availability.setup.profile.durationMinutes ||
      hold.travelBufferMinutes !==
        availability.setup.profile.travelBufferMinutes ||
      hold.capacityPoolKey !== availability.setup.profile.capacityPoolKey ||
      hold.capacityUnits !== availability.setup.profile.capacityUnits
    ) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "Scheduling rules changed while this window was held. Choose a window again.",
        { status: 409 },
      );
    }
    const selectedCandidate = availability.result.candidates.find(
      (candidate) => candidate.startAt.getTime() === hold.startAt.getTime(),
    );
    if (!selectedCandidate?.available) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "That arrival window is no longer available.",
        { status: 409 },
      );
    }
    if (
      stableJson(hold.resourceAssignmentSnapshot) !==
      stableJson(selectedCandidate.resourceAssignments)
    ) {
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "The assigned crew or equipment changed while this window was held. Choose a window again.",
        { status: 409 },
      );
    }
    if (!availability.validation.valid) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Complete the required schedule-change details before submitting.",
        { status: 422, fieldErrors: availability.validation.fieldErrors },
      );
    }

    const baseReviewReasons = normalizeSchedulingReviewReasons([
      ...availability.reviewReasons,
      ...(scheduleChangePolicyRequiresReview
        ? (["schedule_change_policy_review_required"] as const)
        : []),
      ...(!source.accountPortalAccessEnabled
        ? (["manual_review_required"] as const)
        : []),
    ]);
    const eligibility = evaluateInstantConfirmEligibility({
      policyAllowsInstantConfirmation:
        source.accountPortalAccessEnabled &&
        availability.setup.policy.channels.partner_portal
          .allowsInstantConfirmation &&
        isPartnerPortalInstantConfirmationEnabled(input.actor.accountId),
      demandAllowsInstantConfirmation:
        availability.setup.catalog.instantBookable &&
        availability.setup.profile.instantConfirmationEnabled &&
        pricingEligibilityAllowsInstantConfirmation(
          availability.setup.profile.pricingEligibility,
        ),
      capacityReservation: { kind: "active_hold", expiresAt: hold.expiresAt },
      reviewReasons: baseReviewReasons,
      now,
    });
    const reviewReasons = eligibility.eligible
      ? baseReviewReasons
      : normalizeSchedulingReviewReasons([
          ...baseReviewReasons,
          "manual_review_required",
        ]);

    if (eligibility.eligible) {
      const [consumed] = await tx
        .update(appointmentHolds)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(appointmentHolds.id, hold.id),
            eq(appointmentHolds.partnerAccountId, input.actor.accountId),
            eq(appointmentHolds.status, "active"),
            gt(appointmentHolds.expiresAt, now),
          ),
        )
        .returning({ id: appointmentHolds.id });
      if (!consumed) {
        throw new PartnerPortalSchedulingError(
          "hold_expired",
          "The arrival-window hold expired. Choose a window again.",
          { status: 410 },
        );
      }

      const [updatedAppointment] = await tx
        .update(appointments)
        .set({
          startAt: hold.startAt,
          durationMinutes: hold.durationMinutes,
          travelBufferMinutes: hold.travelBufferMinutes,
          capacityPoolKey: hold.capacityPoolKey,
          capacityUnits: hold.capacityUnits,
          promisedArrivalStartAt: hold.arrivalWindowStartAt,
          promisedArrivalEndAt: hold.arrivalWindowEndAt,
          schedulePolicyRevision: hold.policyRevision,
          resourceAssignmentSnapshot: hold.resourceAssignmentSnapshot.map(
            (assignment) => ({ ...assignment }),
          ),
          rescheduleToken: randomUUID().replace(/-/gu, ""),
          status: "confirmed",
          updatedAt: now,
        })
        .where(
          and(
            eq(appointments.id, source.appointment.id),
            eq(appointments.status, source.appointment.status),
          ),
        )
        .returning();
      if (!updatedAppointment) {
        throw new PartnerPortalSchedulingError(
          "conflict",
          "The job schedule changed. Refresh and try again.",
          { status: 409 },
        );
      }
      const [updatedBooking] = await tx
        .update(partnerBookings)
        .set({
          publicStatus: "confirmed",
          confirmationMode: "instant",
          arrivalWindowStartAt: hold.arrivalWindowStartAt,
          arrivalWindowEndAt: hold.arrivalWindowEndAt,
          requestedReviewReasons: [],
          rescheduleOperationKeyHash: opHash,
          rescheduleRequestHash: requestHash,
          version: source.booking.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerBookings.id, source.booking.id),
            eq(partnerBookings.version, source.booking.version),
          ),
        )
        .returning();
      if (!updatedBooking) throw new Error("partner_reschedule_revision_race");

      await tx.insert(partnerJobEvents).values({
        partnerAccountId: input.actor.accountId,
        partnerBookingId: source.booking.id,
        eventType: "job.rescheduled",
        publicLabel: "Schedule updated",
        publicDetail: "Your new two-hour arrival window is confirmed.",
        effectiveAt: now,
        actorType: "partner",
        actorMembershipId: input.actor.membershipId,
        metadata: { draftId: draft.id },
        createdAt: now,
      });
      await queuePartnerBookingNotification({
        tx,
        accountId: input.actor.accountId,
        membershipId:
          source.booking.requestedByMembershipId ?? input.actor.membershipId,
        fallbackMembershipId: input.actor.membershipId,
        partnerBookingId: source.booking.id,
        eventType: "booking.rescheduled",
        dedupeKey: opHash,
        correlationId: input.correlationId,
        occurredAt: now,
        accountTimezone: location.timezone,
        serviceAt: hold.arrivalWindowStartAt,
      });
      await tx.insert(appointmentNotes).values({
        appointmentId: source.appointment.id,
        body: [
          "[partner-portal-v2-reschedule]",
          `Requested by: ${input.actor.email}`,
          `Previous internal start: ${source.appointment.startAt.toISOString()}`,
          `New internal start: ${hold.startAt.toISOString()}`,
          `Promised arrival window: ${hold.arrivalWindowStartAt.toISOString()} – ${hold.arrivalWindowEndAt.toISOString()}`,
        ].join("\n"),
        createdAt: now,
      });
      await tx.insert(outboxEvents).values({
        type: "appointment.calendar_sync_requested",
        payload: {
          appointmentId: source.appointment.id,
          version: updatedAppointment.updatedAt.toISOString(),
          reason: "partner.portal.v2.booking.rescheduled",
          requestedCalendarEventId: source.appointment.calendarEventId,
          correlationId: input.correlationId,
        },
        createdAt: now,
      });
      const [submittedDraft] = await tx
        .update(partnerBookingDrafts)
        .set({
          state: "submitted",
          reviewReasons: [],
          validation: {
            ...draft.validation,
            valid: true,
            ready: true,
            fieldErrors: {},
            checkedAt: now.toISOString(),
            rescheduleMode: "instant",
            partnerBookingId: source.booking.id,
          },
          revision: draft.revision + 1,
          submittedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
            eq(partnerBookingDrafts.id, draft.id),
            eq(partnerBookingDrafts.revision, draft.revision),
          ),
        )
        .returning({ id: partnerBookingDrafts.id });
      if (!submittedDraft) throw new Error("partner_reschedule_draft_race");

      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: input.actor.partnerUserId,
        actorRole: "partner",
        actorLabel: input.actor.email,
        sessionId: input.actor.sessionId,
        authMethod: "partner_session",
        correlationId: input.correlationId,
        requiredPermissions: ["bookings.update"],
        outcome: "succeeded",
        surface: `/partners/jobs/${source.booking.id}/reschedule`,
        idempotencyKeyHash: opHash,
        action: "partner.portal.v2.booking.rescheduled",
        entityType: "partner_booking",
        entityId: source.booking.id,
        meta: sanitizeAuditMetadata({
          accountId: input.actor.accountId,
          membershipId: input.actor.membershipId,
          draftId: draft.id,
          holdId: hold.id,
          previousStartAt: source.appointment.startAt.toISOString(),
          newStartAt: hold.startAt.toISOString(),
          policyRevision: availability.setup.policy.revision,
          cancellationPolicyRevision: cancellationPolicy.revision,
          cancellationPolicySource: cancellationPolicy.source,
          scheduleChangePolicyReason: scheduleChangePolicyDecision.reason.code,
        }),
        createdAt: now,
      });
      return {
        result: createPartnerRescheduleResultDto({
          mode: "instant",
          booking: updatedBooking,
        }),
        replayed: false,
      };
    }

    const [released] = await tx
      .update(appointmentHolds)
      .set({ status: "released", updatedAt: now })
      .where(
        and(
          eq(appointmentHolds.id, hold.id),
          eq(appointmentHolds.partnerAccountId, input.actor.accountId),
          eq(appointmentHolds.status, "active"),
        ),
      )
      .returning({ id: appointmentHolds.id });
    if (!released) {
      throw new PartnerPortalSchedulingError(
        "hold_expired",
        "The arrival-window hold expired. Choose a window again.",
        { status: 410 },
      );
    }

    const [pendingRequest] = await tx
      .select({ id: partnerRescheduleRequests.id })
      .from(partnerRescheduleRequests)
      .where(
        and(
          eq(partnerRescheduleRequests.partnerAccountId, input.actor.accountId),
          eq(partnerRescheduleRequests.partnerBookingId, source.booking.id),
          eq(partnerRescheduleRequests.state, "pending"),
        ),
      )
      .limit(1);
    if (pendingRequest) {
      throw new PartnerPortalSchedulingError(
        "conflict",
        "A schedule-change request is already awaiting review.",
        { status: 409 },
      );
    }
    const [reviewRequest] = await tx
      .insert(partnerRescheduleRequests)
      .values({
        partnerAccountId: input.actor.accountId,
        partnerBookingId: source.booking.id,
        bookingDraftId: draft.id,
        state: "pending",
        proposedStartAt: hold.startAt,
        requestedArrivalStartAt: hold.arrivalWindowStartAt,
        requestedArrivalEndAt: hold.arrivalWindowEndAt,
        previousStartAt: source.appointment.startAt,
        previousArrivalStartAt: source.booking.arrivalWindowStartAt,
        previousArrivalEndAt: source.booking.arrivalWindowEndAt,
        reviewReasons: [...reviewReasons],
        operationKeyHash: opHash,
        requestHash,
        createdByMembershipId: input.actor.membershipId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!reviewRequest) throw new Error("partner_reschedule_request_failed");
    const [updatedBooking] = await tx
      .update(partnerBookings)
      .set({
        version: source.booking.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookings.id, source.booking.id),
          eq(partnerBookings.version, source.booking.version),
        ),
      )
      .returning();
    if (!updatedBooking) throw new Error("partner_reschedule_revision_race");
    const [submittedDraft] = await tx
      .update(partnerBookingDrafts)
      .set({
        state: "submitted",
        reviewReasons: [...reviewReasons],
        validation: {
          ...draft.validation,
          valid: true,
          ready: true,
          fieldErrors: {},
          checkedAt: now.toISOString(),
          rescheduleMode: "review",
          rescheduleRequestId: reviewRequest.id,
        },
        revision: draft.revision + 1,
        submittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookingDrafts.partnerAccountId, input.actor.accountId),
          eq(partnerBookingDrafts.id, draft.id),
          eq(partnerBookingDrafts.revision, draft.revision),
        ),
      )
      .returning({ id: partnerBookingDrafts.id });
    if (!submittedDraft) throw new Error("partner_reschedule_draft_race");
    await tx.insert(partnerJobEvents).values({
      partnerAccountId: input.actor.accountId,
      partnerBookingId: source.booking.id,
      eventType: "job.reschedule_review_requested",
      publicLabel: "Schedule change requested",
      publicDetail:
        "The current schedule remains in place while Stonegate reviews your requested window.",
      effectiveAt: now,
      actorType: "partner",
      actorMembershipId: input.actor.membershipId,
      metadata: {
        requestId: reviewRequest.id,
        draftId: draft.id,
        cancellationPolicyRevision: cancellationPolicy.revision,
        scheduleChangePolicyReason: scheduleChangePolicyDecision.reason.code,
      },
      createdAt: now,
    });
    await queuePartnerBookingNotification({
      tx,
      accountId: input.actor.accountId,
      membershipId:
        source.booking.requestedByMembershipId ?? input.actor.membershipId,
      fallbackMembershipId: input.actor.membershipId,
      partnerBookingId: source.booking.id,
      eventType: "booking.reschedule_review_requested",
      dedupeKey: opHash,
      correlationId: input.correlationId,
      occurredAt: now,
      accountTimezone: location.timezone,
      serviceAt: hold.arrivalWindowStartAt,
    });
    await tx.insert(appointmentNotes).values({
      appointmentId: source.appointment.id,
      body: [
        "[partner-portal-v2-reschedule-review]",
        `Requested by: ${input.actor.email}`,
        `Requested internal start: ${hold.startAt.toISOString()}`,
        `Requested arrival window: ${hold.arrivalWindowStartAt.toISOString()} – ${hold.arrivalWindowEndAt.toISOString()}`,
        `Review reasons: ${reviewReasons.join(", ")}`,
        "The existing appointment remains unchanged.",
      ].join("\n"),
      createdAt: now,
    });
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.actor.partnerUserId,
      actorRole: "partner",
      actorLabel: input.actor.email,
      sessionId: input.actor.sessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["bookings.update"],
      outcome: "succeeded",
      surface: `/partners/jobs/${source.booking.id}/reschedule`,
      idempotencyKeyHash: opHash,
      action: "partner.portal.v2.booking.reschedule_review_requested",
      entityType: "partner_reschedule_request",
      entityId: reviewRequest.id,
      meta: sanitizeAuditMetadata({
        accountId: input.actor.accountId,
        membershipId: input.actor.membershipId,
        partnerBookingId: source.booking.id,
        draftId: draft.id,
        holdId: hold.id,
        requestedStartAt: hold.startAt.toISOString(),
        currentSchedulePreserved: true,
        cancellationPolicyRevision: cancellationPolicy.revision,
        cancellationPolicySource: cancellationPolicy.source,
        scheduleChangePolicyReason: scheduleChangePolicyDecision.reason.code,
        reviewReasons,
      }),
      createdAt: now,
    });
    return {
      result: createPartnerRescheduleResultDto({
        mode: "review",
        requestId: reviewRequest.id,
        booking: updatedBooking,
        requestedArrivalWindow: {
          startAt: reviewRequest.requestedArrivalStartAt,
          endAt: reviewRequest.requestedArrivalEndAt,
        },
        reviewReasons,
      }),
      replayed: false,
    };
  });
}
