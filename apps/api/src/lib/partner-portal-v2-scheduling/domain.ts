import { DateTime } from "luxon";
import {
  createScheduleDemand,
  createScheduleOccupancy,
  evaluateWeightedScheduleCapacity,
  groupThirtyMinutePartnerWindows,
  normalizeSchedulingReviewReasons,
  type PartnerAvailabilityWindow,
  type ScheduleCapacityBlock,
  type ScheduleCandidateSlot,
  type ScheduleDemand,
  type SchedulePolicySnapshot,
  type SchedulingReviewReasonCode,
  type SchedulingWeekday,
} from "@/lib/scheduling";
import { PartnerPortalSchedulingError, schedulingFieldError } from "./errors";
import {
  MAX_PARTNER_ADD_ON_QUANTITY,
  MAX_PARTNER_SERVICE_ADD_ONS,
  type PartnerSelectedAddOn,
} from "@/lib/partner-portal-v2-service-add-ons";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PARTNER_ARRIVAL_WINDOW_ID_PATTERN =
  /^(\d{4}-\d{2}-\d{2}):(?:[01]\d|2[0-3])(?:00|30)$/u;
const MAX_TEXT_LENGTH = 4_000;
export const MAX_ACTIVE_PARTNER_DRAFT_MEDIA = 40;
export const MAX_PARTNER_PREFERRED_WINDOWS = 3;
const PARTNER_PREFERRED_TIME_OF_DAY = new Set([
  "morning",
  "afternoon",
  "anytime",
]);
const DRAFT_KEYS = new Set([
  "locationId",
  "serviceKey",
  "tierKey",
  "selectedAddOns",
  "scope",
  "description",
  "crewInstructions",
  "accessDetails",
  "onSiteContact",
  "proofRequirements",
  "commercial",
  "preferredWindows",
]);
const PARTNER_COMMERCIAL_KEYS = new Set([
  "poNumber",
  "costCenter",
  "projectReference",
  "billingContact",
]);
const PARTNER_BILLING_CONTACT_KEYS = new Set(["name", "email"]);
const MAX_PARTNER_COMMERCIAL_REFERENCE_LENGTH = 500;
const MAX_PARTNER_BILLING_NAME_LENGTH = 200;
const MAX_PARTNER_BILLING_EMAIL_LENGTH = 320;

export type PartnerDraftMutation = Readonly<{
  locationId?: string | null;
  serviceKey?: string | null;
  tierKey?: string | null;
  selectedAddOns?: PartnerSelectedAddOn[];
  scope?: Record<string, unknown>;
  description?: string | null;
  crewInstructions?: string | null;
  accessDetails?: string | null;
  onSiteContact?: Record<string, unknown> | null;
  proofRequirements?: Record<string, unknown>;
  commercial?: Record<string, unknown>;
  preferredWindows?: PartnerPreferredWindow[];
}>;

export type PartnerPreferredWindow = Readonly<{
  localDate: string;
  timeOfDay: "morning" | "afternoon" | "anytime";
  timezone: string;
}>;

export type DraftValidationInput = Readonly<{
  locationId: string | null;
  serviceKey: string | null;
  scope: Readonly<Record<string, unknown>>;
  description: string | null;
  onSiteContact: Readonly<Record<string, unknown>> | null;
  proofRequirements: Readonly<Record<string, unknown>>;
  commercial: Readonly<Record<string, unknown>>;
  location: Readonly<{
    id: string;
    propertyId: string | null;
    geocodeStatus: string;
    serviceAreaStatus: string;
    city?: string;
    state?: string;
    postalCode?: string;
  }> | null;
  catalog: Readonly<{
    active: boolean;
    instantBookable: boolean;
    requiredScopeFields: readonly string[];
    automaticReviewRules: Readonly<Record<string, unknown>>;
  }> | null;
  profile: Readonly<{
    requiredScopeFields: readonly string[];
    automaticReviewRules: Readonly<Record<string, unknown>>;
    supportedTerritories?: readonly string[];
  }> | null;
  environmentalReviewReasons?: readonly SchedulingReviewReasonCode[];
}>;

export type DraftValidationResult = Readonly<{
  valid: boolean;
  ready: boolean;
  fieldErrors: Readonly<Record<string, string>>;
  reviewReasons: readonly SchedulingReviewReasonCode[];
}>;

export type PartnerAvailabilityCandidate = ScheduleCandidateSlot &
  Readonly<{
    localDate: string;
    remainingCapacityUnits: number;
    reason: "available" | "outside_hours" | "daily_limit" | "capacity";
  }>;

export type PartnerAvailabilityResult = Readonly<{
  candidates: readonly PartnerAvailabilityCandidate[];
  windows: readonly PartnerAvailabilityWindow<PartnerAvailabilityCandidate>[];
}>;

export type PartnerArrivalWindowDto = Readonly<{
  id: string;
  localDate: string;
  startAt: string;
  endAt: string;
  label: string;
  available: boolean;
}>;

/**
 * The public availability projection deliberately ends at the two-hour
 * promise. Candidate IDs, planned starts, work intervals, buffers, and raw
 * capacity are scheduling-engine details and never cross this boundary.
 */
export function createPartnerArrivalWindowDto(input: {
  id: string;
  localDate: string;
  startAt: Date;
  endAt: Date;
  label: string;
  available: boolean;
}): PartnerArrivalWindowDto {
  if (
    !input.id ||
    !PARTNER_ARRIVAL_WINDOW_ID_PATTERN.test(input.id) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate) ||
    !validDate(input.startAt) ||
    !validDate(input.endAt) ||
    input.endAt.getTime() - input.startAt.getTime() !== 120 * 60_000 ||
    !input.label
  ) {
    throw new TypeError("Invalid partner arrival window.");
  }
  return Object.freeze({
    id: input.id,
    localDate: input.localDate,
    startAt: input.startAt.toISOString(),
    endAt: input.endAt.toISOString(),
    label: input.label,
    available: input.available,
  });
}

export type PartnerAvailabilityScheduleDto = Readonly<{
  timezone: string;
  calendar: Readonly<{
    state: "current" | "stale" | "unconfigured";
  }>;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  instantConfirmationEligible: boolean;
  windows: readonly PartnerArrivalWindowDto[];
}>;

export function createPartnerAvailabilityScheduleDto(input: {
  timezone: string;
  calendarState: "current" | "stale" | "unconfigured";
  reviewReasons: readonly SchedulingReviewReasonCode[];
  instantConfirmationEligible: boolean;
  windows: readonly {
    id: string;
    localDate: string;
    startAt: Date;
    endAt: Date;
    label: string;
    available: boolean;
  }[];
}): PartnerAvailabilityScheduleDto {
  return Object.freeze({
    timezone: input.timezone,
    calendar: Object.freeze({ state: input.calendarState }),
    reviewReasons: normalizeSchedulingReviewReasons(input.reviewReasons),
    instantConfirmationEligible: input.instantConfirmationEligible,
    windows: Object.freeze(input.windows.map(createPartnerArrivalWindowDto)),
  });
}

export type PartnerHoldDto = Readonly<{
  id: string;
  draftId: string;
  status: string;
  arrivalWindowStartAt: string;
  arrivalWindowEndAt: string;
  expiresAt: string;
}>;

export function createPartnerHoldDto(input: {
  id: string;
  draftId: string | null;
  status: string;
  arrivalWindowStartAt: Date | null;
  arrivalWindowEndAt: Date | null;
  expiresAt: Date;
}): PartnerHoldDto {
  if (
    !input.id ||
    !input.draftId ||
    !input.status ||
    !validDate(input.arrivalWindowStartAt) ||
    !validDate(input.arrivalWindowEndAt) ||
    input.arrivalWindowEndAt.getTime() -
      input.arrivalWindowStartAt.getTime() !==
      120 * 60_000 ||
    !validDate(input.expiresAt)
  ) {
    throw new TypeError("Invalid partner hold response.");
  }
  return Object.freeze({
    id: input.id,
    draftId: input.draftId,
    status: input.status,
    arrivalWindowStartAt: input.arrivalWindowStartAt.toISOString(),
    arrivalWindowEndAt: input.arrivalWindowEndAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
}

export type PartnerPublicJobScheduleDto = Readonly<{
  arrivalWindow: Readonly<{
    startAt: string;
    endAt: string;
    timezone: string;
  }> | null;
  completedAt: string | null;
}>;

export function createPartnerPublicJobScheduleDto(input: {
  arrivalWindowStartAt: Date | null;
  arrivalWindowEndAt: Date | null;
  timezone: string | null;
  completedAt: Date | null;
}): PartnerPublicJobScheduleDto {
  const startAt = input.arrivalWindowStartAt;
  const endAt = input.arrivalWindowEndAt;
  const arrivalWindow =
    validDate(startAt) &&
    validDate(endAt) &&
    endAt.getTime() - startAt.getTime() === 120 * 60_000
      ? Object.freeze({
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          timezone: input.timezone ?? "America/New_York",
        })
      : null;
  return Object.freeze({
    arrivalWindow,
    completedAt: input.completedAt?.toISOString() ?? null,
  });
}

export type DraftMediaReadiness = Readonly<{
  activeCount: number;
  readyForInstantConfirmation: boolean;
}>;

export type PartnerBookingSubmissionScheduleDisposition = Readonly<{
  holdStatus: "active" | "consumed" | "released";
  reservesCapacity: boolean;
  retainsApprovalHold: boolean;
}>;

/**
 * An interactive hold becomes durable appointment capacity only for a fully
 * eligible instant confirmation. An otherwise eligible request that needs an
 * account approval keeps the candidate as a short approval hold. Operational
 * review requests release the candidate and preserve only the partner-facing
 * preferred arrival window.
 */
export function partnerBookingSubmissionScheduleDisposition(input: {
  approvalRequired: boolean;
  instantConfirmationEligible: boolean;
}): PartnerBookingSubmissionScheduleDisposition {
  if (
    typeof input.approvalRequired !== "boolean" ||
    typeof input.instantConfirmationEligible !== "boolean"
  ) {
    throw new TypeError("Invalid booking submission schedule disposition.");
  }
  const reservesCapacity =
    input.instantConfirmationEligible && !input.approvalRequired;
  const retainsApprovalHold =
    input.instantConfirmationEligible && input.approvalRequired;
  return Object.freeze({
    holdStatus: reservesCapacity
      ? "consumed"
      : retainsApprovalHold
        ? "active"
        : "released",
    reservesCapacity,
    retainsApprovalHold,
  });
}

export type PartnerBookingAppointmentSchedule = Readonly<{
  startAt: Date | null;
  promisedArrivalStartAt: Date | null;
  promisedArrivalEndAt: Date | null;
  schedulePolicyRevision: string | null;
}>;

export function partnerBookingSubmissionAppointmentSchedule(input: {
  disposition: PartnerBookingSubmissionScheduleDisposition;
  internalStartAt: Date;
  preferredArrivalStartAt: Date;
  preferredArrivalEndAt: Date;
  policyRevision: string;
}): PartnerBookingAppointmentSchedule {
  if (
    !validDate(input.internalStartAt) ||
    !validDate(input.preferredArrivalStartAt) ||
    !validDate(input.preferredArrivalEndAt) ||
    input.preferredArrivalEndAt <= input.preferredArrivalStartAt ||
    !input.policyRevision
  ) {
    throw new TypeError("Invalid booking submission appointment schedule.");
  }
  if (!input.disposition.reservesCapacity) {
    return Object.freeze({
      startAt: null,
      promisedArrivalStartAt: null,
      promisedArrivalEndAt: null,
      schedulePolicyRevision: null,
    });
  }
  return Object.freeze({
    startAt: new Date(input.internalStartAt.getTime()),
    promisedArrivalStartAt: new Date(input.preferredArrivalStartAt.getTime()),
    promisedArrivalEndAt: new Date(input.preferredArrivalEndAt.getTime()),
    schedulePolicyRevision: input.policyRevision,
  });
}

export type SubmittedPartnerBookingDto = Readonly<{
  id: string;
  draftId: string;
  publicStatus: string;
  confirmationMode: string;
  arrivalWindowStartAt: string | null;
  arrivalWindowEndAt: string | null;
  reviewReasons: readonly SchedulingReviewReasonCode[];
  version: number;
  createdAt: string;
}>;

/** Builds the immediate submission response without internal schedule IDs/times. */
export function createSubmittedPartnerBookingDto(input: {
  id: string;
  draftId: string;
  publicStatus: string;
  confirmationMode: string;
  arrivalWindowStartAt: Date | null;
  arrivalWindowEndAt: Date | null;
  reviewReasons: readonly unknown[];
  version: number;
  createdAt: Date;
}): SubmittedPartnerBookingDto {
  if (
    !input.id ||
    !input.draftId ||
    (input.arrivalWindowStartAt === null) !==
      (input.arrivalWindowEndAt === null) ||
    (input.arrivalWindowStartAt !== null &&
      input.arrivalWindowEndAt !== null &&
      (!validDate(input.arrivalWindowStartAt) ||
        !validDate(input.arrivalWindowEndAt) ||
        input.arrivalWindowEndAt <= input.arrivalWindowStartAt)) ||
    !validDate(input.createdAt)
  ) {
    throw new TypeError("Invalid submitted partner booking response.");
  }
  return Object.freeze({
    id: input.id,
    draftId: input.draftId,
    publicStatus: input.publicStatus,
    confirmationMode: input.confirmationMode,
    arrivalWindowStartAt: input.arrivalWindowStartAt?.toISOString() ?? null,
    arrivalWindowEndAt: input.arrivalWindowEndAt?.toISOString() ?? null,
    reviewReasons: normalizeSchedulingReviewReasons(input.reviewReasons),
    version: input.version,
    createdAt: input.createdAt.toISOString(),
  });
}

export type CalendarCoverageState = "current" | "stale" | "unconfigured";

function validDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function evaluateCalendarCoverageState(input: {
  configured: boolean;
  now: Date;
  staleMinutes: number;
  lastSyncedAt: Date | null;
  externalBusyCoverageSyncedAt: Date | null;
  lastNotificationAt: Date | null;
}): CalendarCoverageState {
  if (
    !input.configured ||
    !validDate(input.lastSyncedAt) ||
    !validDate(input.externalBusyCoverageSyncedAt)
  ) {
    return "unconfigured";
  }
  if (
    !validDate(input.now) ||
    !Number.isSafeInteger(input.staleMinutes) ||
    input.staleMinutes < 1 ||
    input.staleMinutes > 1_440
  ) {
    throw new TypeError("Invalid calendar coverage freshness policy.");
  }
  const staleAt = input.now.getTime() - input.staleMinutes * 60_000;
  const maximumFutureSkew = input.now.getTime() + 5 * 60_000;
  if (
    input.lastSyncedAt.getTime() < staleAt ||
    input.externalBusyCoverageSyncedAt.getTime() < staleAt ||
    input.lastSyncedAt.getTime() > maximumFutureSkew ||
    input.externalBusyCoverageSyncedAt.getTime() > maximumFutureSkew ||
    (validDate(input.lastNotificationAt)
      ? input.lastNotificationAt.getTime() > input.lastSyncedAt.getTime()
      : false)
  ) {
    return "stale";
  }
  return "current";
}

export function calendarAvailabilityReviewReasons(input: {
  state: "current" | "stale" | "unconfigured";
  externalBusyCoverageVerified: boolean;
}): readonly SchedulingReviewReasonCode[] {
  if (input.state === "unconfigured") {
    return Object.freeze(["calendar_unconfigured"]);
  }
  if (input.state === "stale") return Object.freeze(["calendar_stale"]);
  return input.externalBusyCoverageVerified
    ? Object.freeze([])
    : Object.freeze(["availability_unverified"]);
}

export type PartnerJobEvidenceTransferValue = Readonly<{
  partnerAccountId: string;
  partnerBookingId: string;
  mediaAssetId: string;
  category: string;
  caption: string | null;
  sortOrder: number;
  uploadedByMembershipId: string | null;
  createdAt: Date;
}>;

export function evaluateDraftMediaReadiness(
  items: readonly Readonly<{
    status: string;
    readyAt: Date | null;
    deletedAt: Date | null;
  }>[],
): DraftMediaReadiness {
  if (items.length > MAX_ACTIVE_PARTNER_DRAFT_MEDIA) {
    throw schedulingFieldError({
      media: "Remove at least one file before submitting this booking.",
    });
  }
  return Object.freeze({
    activeCount: items.length,
    readyForInstantConfirmation: items.every(
      (item) =>
        item.status === "ready" &&
        item.readyAt instanceof Date &&
        Number.isFinite(item.readyAt.getTime()) &&
        item.deletedAt === null,
    ),
  });
}

export function buildPartnerJobEvidenceTransferValues(input: {
  partnerAccountId: string;
  partnerBookingId: string;
  createdAt: Date;
  associations: readonly Readonly<{
    mediaAssetId: string;
    category: string;
    caption: string | null;
    sortOrder: number;
    uploadedByMembershipId: string | null;
  }>[];
}): readonly PartnerJobEvidenceTransferValue[] {
  if (
    !input.partnerAccountId ||
    !input.partnerBookingId ||
    !Number.isFinite(input.createdAt.getTime()) ||
    input.associations.length > MAX_ACTIVE_PARTNER_DRAFT_MEDIA
  ) {
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "The draft media transfer is invalid.",
      { status: 422 },
    );
  }
  return Object.freeze(
    input.associations.map((association) =>
      Object.freeze({
        partnerAccountId: input.partnerAccountId,
        partnerBookingId: input.partnerBookingId,
        mediaAssetId: association.mediaAssetId,
        category: association.category,
        caption: association.caption,
        sortOrder: association.sortOrder,
        uploadedByMembershipId: association.uploadedByMembershipId,
        createdAt: new Date(input.createdAt.getTime()),
      }),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw schedulingFieldError({ [field]: "Enter a valid object." });
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > 32_000) throw new Error("too_large");
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    throw schedulingFieldError({ [field]: "This information is invalid." });
  }
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw schedulingFieldError({ [field]: "Enter valid text." });
  }
  const text = value.normalize("NFKC").trim();
  if (text.length === 0) return null;
  const hasDisallowedControl = [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 127 || (codePoint < 32 && ![9, 10, 13].includes(codePoint))
    );
  });
  if (text.length > MAX_TEXT_LENGTH || hasDisallowedControl) {
    throw schedulingFieldError({
      [field]: `Use ${MAX_TEXT_LENGTH.toLocaleString()} characters or fewer.`,
    });
  }
  return text;
}

function boundedDraftText(
  value: unknown,
  field: string,
  maximumLength: number,
  options: { allowEmpty?: boolean } = {},
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw schedulingFieldError({ [field]: "Enter valid text." });
  }
  const text = value.normalize("NFKC").trim();
  const hasDisallowedControl = [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 127 || (codePoint < 32 && ![9, 10, 13].includes(codePoint))
    );
  });
  if (text.length > maximumLength || hasDisallowedControl) {
    throw schedulingFieldError({
      [field]: `Use ${maximumLength.toLocaleString()} characters or fewer.`,
    });
  }
  if (!text && options.allowEmpty !== true) return null;
  return text;
}

function parsePartnerCommercial(value: unknown): Record<string, unknown> {
  const commercial = cloneJsonRecord(value, "commercial");
  const unsupported = Object.keys(commercial).filter(
    (key) => !PARTNER_COMMERCIAL_KEYS.has(key),
  );
  if (unsupported.length > 0) {
    throw schedulingFieldError({
      [`commercial.${unsupported[0]}`]: "This field is not supported.",
    });
  }

  const result: Record<string, unknown> = {};
  for (const key of ["poNumber", "costCenter", "projectReference"] as const) {
    if (!(key in commercial)) continue;
    const text = boundedDraftText(
      commercial[key],
      `commercial.${key}`,
      MAX_PARTNER_COMMERCIAL_REFERENCE_LENGTH,
    );
    if (text) result[key] = text;
  }

  if ("billingContact" in commercial) {
    const billingContact = commercial["billingContact"];
    if (!isRecord(billingContact)) {
      throw schedulingFieldError({
        "commercial.billingContact": "Enter a valid billing contact.",
      });
    }
    const unsupportedBillingKeys = Object.keys(billingContact).filter(
      (key) => !PARTNER_BILLING_CONTACT_KEYS.has(key),
    );
    if (unsupportedBillingKeys.length > 0) {
      throw schedulingFieldError({
        [`commercial.billingContact.${unsupportedBillingKeys[0]}`]:
          "This field is not supported.",
      });
    }
    if (!("name" in billingContact) || !("email" in billingContact)) {
      throw schedulingFieldError({
        "commercial.billingContact": "Add both a name and email.",
      });
    }
    result["billingContact"] = Object.freeze({
      name:
        boundedDraftText(
          billingContact["name"],
          "commercial.billingContact.name",
          MAX_PARTNER_BILLING_NAME_LENGTH,
          { allowEmpty: true },
        ) ?? "",
      email:
        boundedDraftText(
          billingContact["email"],
          "commercial.billingContact.email",
          MAX_PARTNER_BILLING_EMAIL_LENGTH,
          { allowEmpty: true },
        ) ?? "",
    });
  }
  return result;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw schedulingFieldError({ [field]: "Choose a valid location." });
  }
  return value.trim().toLowerCase();
}

export function requirePortalUuid(value: unknown, field = "id"): string {
  const parsed = optionalUuid(value, field);
  if (!parsed)
    throw schedulingFieldError({ [field]: "A valid ID is required." });
  return parsed;
}

export function requirePartnerArrivalWindowId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !PARTNER_ARRIVAL_WINDOW_ID_PATTERN.test(value)
  ) {
    throw schedulingFieldError({
      windowId: "Choose an available two-hour arrival window.",
    });
  }
  const localDate = DateTime.fromISO(value.slice(0, 10), { zone: "utc" });
  if (!localDate.isValid || localDate.toISODate() !== value.slice(0, 10)) {
    throw schedulingFieldError({
      windowId: "Choose an available two-hour arrival window.",
    });
  }
  return value;
}

export function parsePartnerDraftMutation(
  value: unknown,
  options: { requireAtLeastOne?: boolean } = {},
): PartnerDraftMutation {
  if (!isRecord(value)) {
    throw new PartnerPortalSchedulingError(
      "invalid_body",
      "A JSON object is required.",
      { status: 400 },
    );
  }
  const unknownKeys = Object.keys(value).filter((key) => !DRAFT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw schedulingFieldError({
      [unknownKeys[0] ?? "body"]: "This field is not supported.",
    });
  }
  if (options.requireAtLeastOne !== false && Object.keys(value).length === 0) {
    throw new PartnerPortalSchedulingError(
      "invalid_body",
      "At least one draft field is required.",
      { status: 400 },
    );
  }

  const result: Record<string, unknown> = {};
  if ("locationId" in value)
    result["locationId"] = optionalUuid(value["locationId"], "locationId");
  if ("serviceKey" in value) {
    const serviceKey = optionalText(value["serviceKey"], "serviceKey");
    if (serviceKey && !/^[a-z][a-z0-9_-]{1,79}$/u.test(serviceKey)) {
      throw schedulingFieldError({ serviceKey: "Choose a supported service." });
    }
    result["serviceKey"] = serviceKey;
  }
  if ("tierKey" in value) {
    const tierKey = optionalText(value["tierKey"], "tierKey");
    if (tierKey && !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(tierKey)) {
      throw schedulingFieldError({
        tierKey: "Choose a supported base service option.",
      });
    }
    result["tierKey"] = tierKey;
  }
  if ("selectedAddOns" in value) {
    const selections = value["selectedAddOns"];
    if (
      !Array.isArray(selections) ||
      selections.length > MAX_PARTNER_SERVICE_ADD_ONS
    ) {
      throw schedulingFieldError({
        selectedAddOns: `Choose up to ${MAX_PARTNER_SERVICE_ADD_ONS} add-ons.`,
      });
    }
    const normalized: PartnerSelectedAddOn[] = [];
    const seen = new Set<string>();
    for (const selection of selections) {
      if (!isRecord(selection)) {
        throw schedulingFieldError({
          selectedAddOns: "Choose valid add-ons and quantities.",
        });
      }
      const unknownSelectionKeys = Object.keys(selection).filter(
        (key) => key !== "key" && key !== "quantity",
      );
      const key = selection["key"];
      const quantity = selection["quantity"];
      if (
        unknownSelectionKeys.length > 0 ||
        typeof key !== "string" ||
        !/^[a-z][a-z0-9_-]{1,79}$/u.test(key) ||
        seen.has(key) ||
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_PARTNER_ADD_ON_QUANTITY
      ) {
        throw schedulingFieldError({
          selectedAddOns: "Choose valid, non-duplicate add-ons and quantities.",
        });
      }
      seen.add(key);
      normalized.push(Object.freeze({ key, quantity }));
    }
    result["selectedAddOns"] = normalized.sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }
  for (const key of [
    "description",
    "crewInstructions",
    "accessDetails",
  ] as const) {
    if (key in value) result[key] = optionalText(value[key], key);
  }
  for (const key of ["scope", "proofRequirements"] as const) {
    if (key in value) result[key] = cloneJsonRecord(value[key], key);
  }
  if ("commercial" in value) {
    result["commercial"] = parsePartnerCommercial(value["commercial"]);
  }
  if ("onSiteContact" in value) {
    result["onSiteContact"] =
      value["onSiteContact"] === null
        ? null
        : cloneJsonRecord(value["onSiteContact"], "onSiteContact");
  }
  if ("preferredWindows" in value) {
    const windows = value["preferredWindows"];
    if (
      !Array.isArray(windows) ||
      windows.length > MAX_PARTNER_PREFERRED_WINDOWS ||
      !windows.every(isRecord)
    ) {
      throw schedulingFieldError({
        preferredWindows: `Choose up to ${MAX_PARTNER_PREFERRED_WINDOWS} valid time preferences.`,
      });
    }
    const seenDates = new Set<string>();
    result["preferredWindows"] = windows.map((window) => {
      const unsupported = Object.keys(window).filter(
        (key) => !["localDate", "timeOfDay", "timezone"].includes(key),
      );
      const localDate = window["localDate"];
      const timeOfDay = window["timeOfDay"];
      const timezone = window["timezone"];
      let timezoneValid = false;
      if (typeof timezone === "string" && timezone.length <= 100) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
          timezoneValid = true;
        } catch {
          timezoneValid = false;
        }
      }
      const parsedDate =
        typeof localDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(localDate)
          ? DateTime.fromISO(localDate, { zone: "utc" })
          : null;
      if (
        unsupported.length > 0 ||
        !parsedDate?.isValid ||
        parsedDate.toISODate() !== localDate ||
        seenDates.has(localDate) ||
        typeof timeOfDay !== "string" ||
        !PARTNER_PREFERRED_TIME_OF_DAY.has(timeOfDay) ||
        !timezoneValid
      ) {
        throw schedulingFieldError({
          preferredWindows:
            "Choose distinct dates and a valid morning, afternoon, or anytime preference.",
        });
      }
      seenDates.add(localDate);
      return Object.freeze({
        localDate,
        timeOfDay: timeOfDay as PartnerPreferredWindow["timeOfDay"],
        timezone,
      });
    });
  }
  return Object.freeze(result) as PartnerDraftMutation;
}

function valueAtPath(
  record: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = record;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function automaticReviewReasons(
  rules: Readonly<Record<string, unknown>>,
  scope: Readonly<Record<string, unknown>>,
): SchedulingReviewReasonCode[] {
  const reasons: SchedulingReviewReasonCode[] = [];
  const supportedRuleKeys = new Set([
    "alwaysReview",
    "maxItemCount",
    "maxVolumeCubicYards",
  ]);
  if (Object.keys(rules).some((key) => !supportedRuleKeys.has(key))) {
    reasons.push("manual_review_required");
  }
  if (rules["alwaysReview"] === true) reasons.push("service_requires_review");
  if (scope["nonStandard"] === true) reasons.push("non_standard_job");
  if (
    scope["restrictedItems"] === true ||
    (Array.isArray(scope["restrictedItems"]) &&
      scope["restrictedItems"].length > 0)
  ) {
    reasons.push("restricted_item");
  }
  const maxItems = rules["maxItemCount"];
  const itemCount = scope["itemCount"];
  if (
    typeof maxItems === "number" &&
    typeof itemCount === "number" &&
    itemCount > maxItems
  )
    reasons.push("oversized_scope");
  const maxVolume = rules["maxVolumeCubicYards"];
  const volume = scope["volumeCubicYards"];
  if (
    typeof maxVolume === "number" &&
    typeof volume === "number" &&
    volume > maxVolume
  )
    reasons.push("oversized_scope");
  return reasons;
}

export function validatePartnerBookingDraft(
  input: DraftValidationInput,
): DraftValidationResult {
  const fieldErrors: Record<string, string> = {};
  const reviewReasons: SchedulingReviewReasonCode[] = [
    ...(input.environmentalReviewReasons ?? []),
  ];
  if (!input.locationId)
    fieldErrors["locationId"] = "Choose a service location.";
  else if (!input.location || input.location.id !== input.locationId)
    fieldErrors["locationId"] = "Choose an accessible service location.";
  if (!input.serviceKey) fieldErrors["serviceKey"] = "Choose a service.";
  if (!input.description?.trim())
    fieldErrors["description"] = "Describe the work to be completed.";
  const onSiteName = input.onSiteContact?.["name"];
  const onSitePhone = input.onSiteContact?.["phone"];
  const onSiteEmail = input.onSiteContact?.["email"];
  const hasOnSiteName =
    typeof onSiteName === "string" && onSiteName.trim().length > 0;
  const hasOnSitePhone =
    typeof onSitePhone === "string" && onSitePhone.trim().length > 0;
  const hasOnSiteEmail =
    typeof onSiteEmail === "string" && onSiteEmail.trim().length > 0;
  if (!hasOnSiteName || (!hasOnSitePhone && !hasOnSiteEmail)) {
    fieldErrors["onSiteContact"] =
      "Add an on-site contact name and phone or email.";
  }
  if (!input.catalog?.active) reviewReasons.push("service_requires_review");
  if (!input.profile) reviewReasons.push("missing_service_profile");
  if (input.location) {
    if (
      !input.location.propertyId ||
      input.location.geocodeStatus === "pending" ||
      input.location.geocodeStatus === "failed"
    ) {
      reviewReasons.push("property_requires_review");
    }
    if (input.location.serviceAreaStatus !== "eligible")
      reviewReasons.push("service_area_requires_review");
    const territories = input.profile?.supportedTerritories ?? [];
    if (territories.length > 0) {
      const locationTokens = new Set(
        [input.location.city, input.location.state, input.location.postalCode]
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      );
      if (
        !territories.some((territory) =>
          locationTokens.has(territory.trim().toLowerCase()),
        )
      ) {
        reviewReasons.push("service_area_requires_review");
      }
    }
  }
  const requiredScopeFields = new Set([
    ...(input.catalog?.requiredScopeFields ?? []),
    ...(input.profile?.requiredScopeFields ?? []),
  ]);
  for (const rawPath of requiredScopeFields) {
    const path = rawPath.trim();
    if (!path) continue;
    if (path === "description") {
      if (!input.description?.trim()) {
        fieldErrors["description"] = "Describe the work to be completed.";
      }
      continue;
    }
    if (path === "location" || path === "locationId") {
      if (!input.locationId || !input.location) {
        fieldErrors["locationId"] = "Choose a service location.";
      }
      continue;
    }
    if (path === "onSiteContact") {
      if (!hasMeaningfulValue(input.onSiteContact)) {
        fieldErrors["onSiteContact"] = "Add an on-site contact.";
      }
      continue;
    }
    const root = path.startsWith("scope.") ? path.slice(6) : path;
    if (!hasMeaningfulValue(valueAtPath(input.scope, root))) {
      fieldErrors[`scope.${root}`] = "This job detail is required.";
    }
  }
  if (
    !Number.isSafeInteger(input.proofRequirements["before"]) ||
    !Number.isSafeInteger(input.proofRequirements["after"]) ||
    Number(input.proofRequirements["before"]) < 0 ||
    Number(input.proofRequirements["before"]) > 20 ||
    Number(input.proofRequirements["after"]) < 0 ||
    Number(input.proofRequirements["after"]) > 20
  ) {
    fieldErrors["proofRequirements"] =
      "Choose between 0 and 20 before and after photos.";
  }
  const billingContact = input.commercial["billingContact"];
  // Billing contacts are optional. Older snapshots and provider projections may
  // represent an absent optional contact as JSON null, so validate only an
  // actual value. The public mutation parser remains strict for malformed
  // non-null input.
  if (billingContact !== undefined && billingContact !== null) {
    const billingRecord = isRecord(billingContact) ? billingContact : null;
    const billingName = billingRecord?.["name"];
    const billingEmail = billingRecord?.["email"];
    const unsupportedBillingFields = billingRecord
      ? Object.keys(billingRecord).filter(
          (key) => key !== "name" && key !== "email",
        )
      : ["billingContact"];
    if (
      !billingRecord ||
      unsupportedBillingFields.length > 0 ||
      typeof billingName !== "string" ||
      billingName.trim().length < 1 ||
      billingName.trim().length > 200 ||
      typeof billingEmail !== "string" ||
      billingEmail.trim().length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(billingEmail.trim())
    ) {
      fieldErrors["billingContact"] =
        "Add a valid billing contact name and email, or remove both fields.";
    }
  }
  reviewReasons.push(
    ...automaticReviewReasons(
      input.catalog?.automaticReviewRules ?? {},
      input.scope,
    ),
  );
  reviewReasons.push(
    ...automaticReviewReasons(
      input.profile?.automaticReviewRules ?? {},
      input.scope,
    ),
  );
  const normalizedReasons = normalizeSchedulingReviewReasons(reviewReasons);
  const valid = Object.keys(fieldErrors).length === 0;
  return Object.freeze({
    valid,
    ready: valid,
    fieldErrors: Object.freeze(fieldErrors),
    reviewReasons: normalizedReasons,
  });
}

function weekdayKey(local: DateTime): SchedulingWeekday {
  return (
    (
      [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ] as const
    )[local.weekday - 1] ?? "monday"
  );
}

function localDateCapacity(
  policy: SchedulePolicySnapshot,
  localDate: string,
  poolKey: string,
): number {
  const override = policy.dateOverrides.find(
    (entry) => entry.localDate === localDate,
  );
  return (
    override?.capacityByPool?.[poolKey] ??
    policy.capacityPools[poolKey]?.capacityUnits ??
    0
  );
}

function windowsForDate(policy: SchedulePolicySnapshot, day: DateTime) {
  const localDate = day.toISODate() ?? "";
  const override = policy.dateOverrides.find(
    (entry) => entry.localDate === localDate,
  );
  if (override?.closed) return [];
  if (override?.windows && override.windows.length > 0) return override.windows;
  return policy.weeklyHours[weekdayKey(day)];
}

export function computePartnerAvailability(input: {
  policy: SchedulePolicySnapshot;
  demand: ScheduleDemand;
  blocks: readonly ScheduleCapacityBlock[];
  rangeStartAt: Date;
  rangeEndAt: Date;
  now: Date;
  jobsByLocalDate?: Readonly<Record<string, number>>;
  excludeBlockIds?: readonly string[];
}): PartnerAvailabilityResult {
  const { policy, demand } = input;
  if (!policy.capacityPools[demand.capacityPoolKey]) {
    throw new PartnerPortalSchedulingError(
      "service_unavailable",
      "The service capacity pool is not configured.",
      { status: 503, retryable: true },
    );
  }
  const start = DateTime.fromJSDate(input.rangeStartAt, {
    zone: "utc",
  }).setZone(policy.timezone);
  const end = DateTime.fromJSDate(input.rangeEndAt, { zone: "utc" }).setZone(
    policy.timezone,
  );
  const now = DateTime.fromJSDate(input.now, { zone: "utc" });
  if (!start.isValid || !end.isValid || end <= start) {
    throw schedulingFieldError({ range: "Choose a valid availability range." });
  }
  const channel = policy.channels.partner_portal;
  const noticeEarliest = now
    .plus({ minutes: channel.minimumNoticeMinutes })
    .toMillis();
  const calendarLeadEarliest = now
    .setZone(policy.timezone)
    .startOf("day")
    .plus({ days: channel.minimumCalendarLeadDays })
    .toUTC()
    .toMillis();
  const earliest = Math.max(noticeEarliest, calendarLeadEarliest);
  const bookingEnd = now.plus({ days: policy.bookingWindowDays }).toMillis();
  const candidates: PartnerAvailabilityCandidate[] = [];
  const anchors: Record<string, number> = {};
  let day = start.startOf("day");
  const finalDay = end.startOf("day");
  while (day <= finalDay) {
    const localDate = day.toISODate();
    if (!localDate) break;
    const windows = windowsForDate(policy, day);
    if (windows.length > 0) anchors[localDate] = windows[0]?.startMinute ?? 0;
    for (const window of windows) {
      for (
        let minute = window.startMinute;
        minute < window.endMinute;
        minute += policy.slotIntervalMinutes
      ) {
        const localStart = day.plus({ minutes: minute });
        const startAt = localStart.toUTC().toJSDate();
        if (startAt < input.rangeStartAt || startAt >= input.rangeEndAt)
          continue;
        const occupancy = createScheduleOccupancy(startAt, demand);
        const withinHours = minute + demand.durationMinutes <= window.endMinute;
        const withinLeadAndHorizon =
          startAt.getTime() >= earliest && startAt.getTime() <= bookingEnd;
        const dailyCount = input.jobsByLocalDate?.[localDate] ?? 0;
        const underDailyLimit =
          policy.maxJobsPerDay === 0 || dailyCount < policy.maxJobsPerDay;
        const capacity = evaluateWeightedScheduleCapacity({
          candidate: {
            capacityPoolKey: demand.capacityPoolKey,
            capacityUnits: demand.capacityUnits,
            occupancy: occupancy.occupancy,
          },
          poolCapacityUnits: localDateCapacity(
            policy,
            localDate,
            demand.capacityPoolKey,
          ),
          blocks: input.blocks,
          excludeBlockIds: input.excludeBlockIds,
        });
        const available =
          withinHours &&
          withinLeadAndHorizon &&
          underDailyLimit &&
          capacity.available;
        const reason: PartnerAvailabilityCandidate["reason"] =
          !withinHours || !withinLeadAndHorizon
            ? "outside_hours"
            : !underDailyLimit
              ? "daily_limit"
              : !capacity.available
                ? "capacity"
                : "available";
        candidates.push(
          Object.freeze({
            id: startAt.toISOString(),
            startAt,
            workEndAt: occupancy.work.endAt,
            occupancyEndAt: occupancy.occupancy.endAt,
            localDate,
            available,
            reason,
            remainingCapacityUnits: capacity.remainingCapacityUnits,
          }),
        );
      }
    }
    day = day.plus({ days: 1 }).startOf("day");
  }
  const frozen = Object.freeze(
    candidates.sort(
      (left, right) => left.startAt.getTime() - right.startAt.getTime(),
    ),
  );
  return Object.freeze({
    candidates: frozen,
    windows: groupThirtyMinutePartnerWindows(frozen, {
      timezone: policy.timezone,
      anchorMinuteByLocalDate: anchors,
    }),
  });
}

export function schedulingDemandFromProfile(profile: {
  serviceKey: string;
  durationMinutes: number;
  travelBufferMinutes: number;
  capacityPoolKey: string;
  capacityUnits: number;
  instantConfirmationEnabled: boolean;
}): ScheduleDemand {
  return createScheduleDemand({
    serviceKey: profile.serviceKey,
    durationMinutes: profile.durationMinutes,
    travelBufferMinutes: profile.travelBufferMinutes,
    capacityPoolKey: profile.capacityPoolKey,
    capacityUnits: profile.capacityUnits,
    allowsInstantConfirmation: profile.instantConfirmationEnabled,
  });
}
