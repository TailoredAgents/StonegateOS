export type LeadSourceType = "google" | "facebook" | "team_member" | "referral";
export type PriceInputMode = "range" | "exact" | "both";
export type LoadSizeKind =
  | "quarter_to_half"
  | "half_to_three_quarters"
  | "three_quarters_to_full"
  | "custom";
export type AppointmentServiceType =
  | "junk_removal"
  | "land_clearing"
  | "demolition"
  | "rental_dumpster";
export type AppointmentBookingSelection =
  | AppointmentServiceType
  | "in_person_quote";
export type LandClearingAccessDifficulty = "easy" | "moderate" | "hard";
export type DemolitionType =
  | "shed"
  | "deck"
  | "fence"
  | "interior"
  | "concrete"
  | "other";
export type DumpsterSizeKind = "10_yard" | "15_yard" | "20_yard";

export type AppointmentBookingDetails = {
  serviceType: AppointmentServiceType;
  source: {
    type: LeadSourceType;
    teamMemberId?: string | null;
    referralName?: string | null;
  };
  pricing: {
    mode: PriceInputMode;
    rangeMinCents?: number | null;
    rangeMaxCents?: number | null;
  };
  loadSize?: {
    kind: LoadSizeKind;
    customLoads?: number | null;
  } | null;
  landClearing?: {
    areaScope: string;
    accessDifficulty: LandClearingAccessDifficulty;
    haulAway: boolean;
  } | null;
  demolition?: {
    demoType: DemolitionType;
    scopeSize: string;
    haulAway: boolean;
  } | null;
  rentalDumpster?: {
    dumpsterSize: DumpsterSizeKind;
    pickupDate: string;
    placementLocation: string;
  } | null;
};

export type AppointmentLeadSource = AppointmentBookingDetails["source"];

type LeadSourceInput = {
  type: LeadSourceType;
  teamMemberId?: string | null;
  referralName?: string | null;
};

type LeadSourceParseResult =
  | { ok: true; value: LeadSourceInput }
  | { ok: false; error: string };

type AppointmentBookingParseResult =
  | {
      ok: true;
      bookingDetails: AppointmentBookingDetails;
      quotedTotalCents: number | null;
    }
  | { ok: false; error: string };

export const LEAD_SOURCE_OPTIONS: Array<{
  value: LeadSourceType;
  label: string;
}> = [
  { value: "google", label: "Google" },
  { value: "facebook", label: "Facebook" },
  { value: "team_member", label: "Team member" },
  { value: "referral", label: "Referral" },
];

export const APPOINTMENT_SERVICE_TYPE_OPTIONS: Array<{
  value: AppointmentServiceType;
  label: string;
}> = [
  { value: "junk_removal", label: "Junk removal" },
  { value: "land_clearing", label: "Land clearing" },
  { value: "demolition", label: "Demolition" },
  { value: "rental_dumpster", label: "Rental dumpster" },
];

export const APPOINTMENT_BOOKING_SELECTION_OPTIONS: Array<{
  value: AppointmentBookingSelection;
  label: string;
}> = [
  ...APPOINTMENT_SERVICE_TYPE_OPTIONS,
  { value: "in_person_quote", label: "In-person quote only" },
];

export const PRICE_INPUT_MODE_OPTIONS: Array<{
  value: PriceInputMode;
  label: string;
}> = [
  { value: "range", label: "Price range" },
  { value: "exact", label: "Exact quote" },
  { value: "both", label: "Both" },
];

export const LOAD_SIZE_OPTIONS: Array<{ value: LoadSizeKind; label: string }> =
  [
    { value: "quarter_to_half", label: "1/4 - 1/2 load" },
    { value: "half_to_three_quarters", label: "1/2 - 3/4 load" },
    { value: "three_quarters_to_full", label: "3/4 - Full load" },
    { value: "custom", label: "Custom" },
  ];

export const LAND_CLEARING_ACCESS_OPTIONS: Array<{
  value: LandClearingAccessDifficulty;
  label: string;
}> = [
  { value: "easy", label: "Easy access" },
  { value: "moderate", label: "Moderate access" },
  { value: "hard", label: "Hard access" },
];

export const DEMOLITION_TYPE_OPTIONS: Array<{
  value: DemolitionType;
  label: string;
}> = [
  { value: "shed", label: "Shed" },
  { value: "deck", label: "Deck" },
  { value: "fence", label: "Fence" },
  { value: "interior", label: "Interior" },
  { value: "concrete", label: "Concrete" },
  { value: "other", label: "Other" },
];

export const DUMPSTER_SIZE_OPTIONS: Array<{
  value: DumpsterSizeKind;
  label: string;
}> = [
  { value: "10_yard", label: "10-yard dumpster" },
  { value: "15_yard", label: "15-yard dumpster" },
  { value: "20_yard", label: "20-yard dumpster" },
];

export function buildStoredContactSource(input: LeadSourceInput): string {
  switch (input.type) {
    case "google":
      return "google";
    case "facebook":
      return "facebook";
    case "team_member":
      return input.teamMemberId
        ? `team_member:${input.teamMemberId}`
        : "team_member";
    case "referral":
      return input.referralName ? `referral:${input.referralName}` : "referral";
    default:
      return "manual";
  }
}

export function resolveBookingSelection(
  value: string | null | undefined,
): AppointmentBookingSelection {
  const normalized = value?.trim() ?? "";
  if (normalized === "in_person_quote") return normalized;
  return isAppointmentServiceType(normalized) ? normalized : "junk_removal";
}

export function resolveAppointmentServiceType(
  details: AppointmentBookingDetails | null | undefined,
): AppointmentServiceType | null {
  if (details?.serviceType && isAppointmentServiceType(details.serviceType)) {
    return details.serviceType;
  }
  if (details?.loadSize) {
    return "junk_removal";
  }
  return null;
}

export function parseLeadSourceFormData(
  formData: FormData,
): LeadSourceParseResult {
  const typeRaw = readText(formData.get("sourceType"));
  if (!typeRaw) {
    return { ok: false, error: "Where from is required." };
  }

  if (!isLeadSourceType(typeRaw)) {
    return { ok: false, error: "Where from selection is invalid." };
  }

  if (typeRaw === "team_member") {
    const teamMemberId = readText(formData.get("sourceTeamMemberId"));
    if (!teamMemberId) {
      return { ok: false, error: "Pick the team member source." };
    }
    return { ok: true, value: { type: typeRaw, teamMemberId } };
  }

  if (typeRaw === "referral") {
    const referralName = readText(formData.get("sourceReferralName"));
    if (!referralName) {
      return { ok: false, error: "Referral name is required." };
    }
    return { ok: true, value: { type: typeRaw, referralName } };
  }

  return { ok: true, value: { type: typeRaw } };
}

export function parseAppointmentBookingFormData(
  formData: FormData,
): AppointmentBookingParseResult {
  const sourceResult = parseLeadSourceFormData(formData);
  if (!sourceResult.ok) {
    return sourceResult;
  }

  const serviceTypeRaw = readText(formData.get("serviceType"));
  if (!serviceTypeRaw || !isAppointmentServiceType(serviceTypeRaw)) {
    return { ok: false, error: "Job type is required." };
  }

  const modeRaw =
    serviceTypeRaw === "rental_dumpster"
      ? "exact"
      : readText(formData.get("priceInputMode"));
  if (!modeRaw || !isPriceInputMode(modeRaw)) {
    return { ok: false, error: "Price mode is required." };
  }

  const quotedTotalCents = parseUsdToCents(formData.get("quotedTotal"));
  const rangeMinCents = parseUsdToCents(formData.get("priceRangeMin"));
  const rangeMaxCents = parseUsdToCents(formData.get("priceRangeMax"));

  if (
    (modeRaw === "exact" || modeRaw === "both") &&
    quotedTotalCents === null
  ) {
    return { ok: false, error: "Exact quote is required for that price mode." };
  }

  if (modeRaw === "range" || modeRaw === "both") {
    if (rangeMinCents === null || rangeMaxCents === null) {
      return {
        ok: false,
        error: "Price range min and max are required for that price mode.",
      };
    }
    if (rangeMaxCents < rangeMinCents) {
      return {
        ok: false,
        error: "Price range max must be greater than or equal to min.",
      };
    }
  }

  const pricing = {
    mode: modeRaw,
    rangeMinCents:
      modeRaw === "range" || modeRaw === "both" ? rangeMinCents : null,
    rangeMaxCents:
      modeRaw === "range" || modeRaw === "both" ? rangeMaxCents : null,
  };

  if (serviceTypeRaw === "junk_removal") {
    const loadSizeRaw = readText(formData.get("loadSize"));
    if (!loadSizeRaw || !isLoadSizeKind(loadSizeRaw)) {
      return { ok: false, error: "Load size is required." };
    }

    let customLoads: number | null = null;
    if (loadSizeRaw === "custom") {
      customLoads = parsePositiveDecimal(formData.get("customLoads"));
      if (customLoads === null) {
        return {
          ok: false,
          error: "How many loads is required for custom load size.",
        };
      }
    }

    return {
      ok: true,
      quotedTotalCents: modeRaw === "range" ? null : quotedTotalCents,
      bookingDetails: {
        serviceType: serviceTypeRaw,
        source: sourceResult.value,
        pricing,
        loadSize: {
          kind: loadSizeRaw,
          customLoads,
        },
      },
    };
  }

  if (serviceTypeRaw === "land_clearing") {
    const areaScope = readText(formData.get("landClearingAreaScope"));
    const accessDifficulty = readText(
      formData.get("landClearingAccessDifficulty"),
    );
    const haulAway = parseYesNoBoolean(formData.get("landClearingHaulAway"));

    if (!areaScope) {
      return { ok: false, error: "Area or scope is required." };
    }
    if (
      !accessDifficulty ||
      !isLandClearingAccessDifficulty(accessDifficulty)
    ) {
      return { ok: false, error: "Access difficulty is required." };
    }
    if (haulAway === null) {
      return { ok: false, error: "Haul-away selection is required." };
    }

    return {
      ok: true,
      quotedTotalCents: modeRaw === "range" ? null : quotedTotalCents,
      bookingDetails: {
        serviceType: serviceTypeRaw,
        source: sourceResult.value,
        pricing,
        landClearing: {
          areaScope,
          accessDifficulty,
          haulAway,
        },
      },
    };
  }

  if (serviceTypeRaw === "demolition") {
    const demoTypeRaw = readText(formData.get("demolitionType"));
    const scopeSize = readText(formData.get("demolitionScopeSize"));
    const haulAway = parseYesNoBoolean(formData.get("demolitionHaulAway"));

    if (!demoTypeRaw || !isDemolitionType(demoTypeRaw)) {
      return { ok: false, error: "Demolition type is required." };
    }
    if (!scopeSize) {
      return { ok: false, error: "Scope size is required." };
    }
    if (haulAway === null) {
      return { ok: false, error: "Haul-away selection is required." };
    }

    return {
      ok: true,
      quotedTotalCents: modeRaw === "range" ? null : quotedTotalCents,
      bookingDetails: {
        serviceType: serviceTypeRaw,
        source: sourceResult.value,
        pricing,
        demolition: {
          demoType: demoTypeRaw,
          scopeSize,
          haulAway,
        },
      },
    };
  }

  const dumpsterSizeRaw = readText(formData.get("dumpsterSize"));
  const pickupDate = readText(formData.get("dumpsterPickupDate"));
  const placementLocation = readText(formData.get("dumpsterPlacementLocation"));

  if (!dumpsterSizeRaw || !isDumpsterSizeKind(dumpsterSizeRaw)) {
    return { ok: false, error: "Dumpster size is required." };
  }
  if (!pickupDate) {
    return { ok: false, error: "Pickup date is required." };
  }
  if (!placementLocation) {
    return { ok: false, error: "Placement location is required." };
  }

  return {
    ok: true,
    quotedTotalCents,
    bookingDetails: {
      serviceType: serviceTypeRaw,
      source: sourceResult.value,
      pricing: {
        mode: "exact",
        rangeMinCents: null,
        rangeMaxCents: null,
      },
      rentalDumpster: {
        dumpsterSize: dumpsterSizeRaw,
        pickupDate,
        placementLocation,
      },
    },
  };
}

export function formatStoredContactSource(
  value: string | null | undefined,
  teamMemberNameById?: Map<string, string>,
): string | null {
  const parsed = parseStoredContactSourceValue(value);
  if (!parsed) return null;

  switch (parsed.type) {
    case "google":
      return "Google";
    case "facebook":
      return "Facebook";
    case "team_member":
      return parsed.teamMemberId
        ? `Team member: ${teamMemberNameById?.get(parsed.teamMemberId) ?? "Assigned team member"}`
        : "Team member";
    case "referral":
      return parsed.referralName
        ? `Referral: ${parsed.referralName}`
        : "Referral";
    default:
      return value ?? null;
  }
}

export function formatAppointmentLeadSource(
  details: AppointmentBookingDetails | null | undefined,
  teamMemberNameById?: Map<string, string>,
): string | null {
  const source = details?.source;
  if (!source) return null;

  switch (source.type) {
    case "google":
      return "Google";
    case "facebook":
      return "Facebook";
    case "team_member":
      return source.teamMemberId
        ? `Team member: ${teamMemberNameById?.get(source.teamMemberId) ?? "Assigned team member"}`
        : "Team member";
    case "referral":
      return source.referralName
        ? `Referral: ${source.referralName}`
        : "Referral";
    default:
      return null;
  }
}

export function formatAppointmentServiceType(
  details: AppointmentBookingDetails | null | undefined,
): string | null {
  const serviceType = resolveAppointmentServiceType(details);
  return serviceType ? formatServiceTypeLabel(serviceType) : null;
}

export function formatAppointmentPricing(
  details: AppointmentBookingDetails | null | undefined,
  quotedTotalCents: number | null | undefined,
): string | null {
  const pricing = details?.pricing;
  if (!pricing) return null;

  const exact = formatUsdCents(quotedTotalCents);
  const rangeMin = formatUsdCents(pricing.rangeMinCents);
  const rangeMax = formatUsdCents(pricing.rangeMaxCents);

  if (pricing.mode === "exact") {
    return exact ? `Exact quote: ${exact}` : null;
  }

  if (pricing.mode === "range") {
    return rangeMin && rangeMax
      ? `Price range: ${rangeMin} - ${rangeMax}`
      : null;
  }

  if (pricing.mode === "both") {
    if (exact && rangeMin && rangeMax) {
      return `Price range: ${rangeMin} - ${rangeMax} / Exact quote: ${exact}`;
    }
    return (
      exact ??
      (rangeMin && rangeMax ? `Price range: ${rangeMin} - ${rangeMax}` : null)
    );
  }

  return null;
}

export function formatAppointmentJobDetails(
  details: AppointmentBookingDetails | null | undefined,
): string | null {
  const serviceType = resolveAppointmentServiceType(details);
  if (!serviceType) return null;

  if (serviceType === "junk_removal") {
    return formatAppointmentLoadSize(details);
  }

  if (serviceType === "land_clearing") {
    const areaScope = details?.landClearing?.areaScope?.trim();
    const access = details?.landClearing?.accessDifficulty;
    const haulAway = details?.landClearing?.haulAway;
    const parts = [
      areaScope ? `Area: ${areaScope}` : null,
      access ? `Access: ${formatLandClearingAccessLabel(access)}` : null,
      typeof haulAway === "boolean"
        ? `Haul-away: ${haulAway ? "Yes" : "No"}`
        : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" / ") : null;
  }

  if (serviceType === "demolition") {
    const demoType = details?.demolition?.demoType;
    const scopeSize = details?.demolition?.scopeSize?.trim();
    const haulAway = details?.demolition?.haulAway;
    const parts = [
      demoType ? formatDemolitionTypeLabel(demoType) : null,
      scopeSize ? `Scope: ${scopeSize}` : null,
      typeof haulAway === "boolean"
        ? `Haul-away: ${haulAway ? "Yes" : "No"}`
        : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" / ") : null;
  }

  const dumpsterSize = details?.rentalDumpster?.dumpsterSize;
  const pickupDate = details?.rentalDumpster?.pickupDate?.trim();
  const placementLocation =
    details?.rentalDumpster?.placementLocation?.trim() ?? "";
  const parts = [
    dumpsterSize ? formatDumpsterSizeLabel(dumpsterSize) : null,
    pickupDate ? `Pickup: ${formatShortDate(pickupDate)}` : null,
    placementLocation ? `Placement: ${placementLocation}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

export function formatAppointmentLoadSize(
  details: AppointmentBookingDetails | null | undefined,
): string | null {
  const loadSize = details?.loadSize;
  if (!loadSize) return null;

  switch (loadSize.kind) {
    case "quarter_to_half":
      return "1/4 - 1/2 load";
    case "half_to_three_quarters":
      return "1/2 - 3/4 load";
    case "three_quarters_to_full":
      return "3/4 - Full load";
    case "custom":
      return loadSize.customLoads
        ? `Custom (${trimTrailingZeros(loadSize.customLoads)} loads)`
        : "Custom";
    default:
      return null;
  }
}

export function formatUsdCents(
  value: number | null | undefined,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value / 100);
  } catch {
    return `$${(value / 100).toFixed(2)}`;
  }
}

export function parseStoredContactSourceValue(
  value: string | null | undefined,
): LeadSourceInput | null {
  const normalized = readText(value);
  if (!normalized) return null;

  if (normalized === "google" || normalized === "facebook") {
    return { type: normalized };
  }

  if (normalized.startsWith("team_member:")) {
    const teamMemberId = normalized.slice("team_member:".length).trim();
    return teamMemberId
      ? { type: "team_member", teamMemberId }
      : { type: "team_member" };
  }

  if (normalized.startsWith("referral:")) {
    const referralName = normalized.slice("referral:".length).trim();
    return referralName
      ? { type: "referral", referralName }
      : { type: "referral" };
  }

  return null;
}

function readText(
  value: FormDataEntryValue | string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUsdToCents(value: FormDataEntryValue | null): number | null {
  const text = readText(value);
  if (!text) return null;
  const parsed = Number(text.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parsePositiveDecimal(value: FormDataEntryValue | null): number | null {
  const text = readText(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseYesNoBoolean(value: FormDataEntryValue | null): boolean | null {
  const text = readText(value);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (normalized === "yes" || normalized === "true") return true;
  if (normalized === "no" || normalized === "false") return false;
  return null;
}

function isLeadSourceType(value: string): value is LeadSourceType {
  return (
    value === "google" ||
    value === "facebook" ||
    value === "team_member" ||
    value === "referral"
  );
}

function isPriceInputMode(value: string): value is PriceInputMode {
  return value === "range" || value === "exact" || value === "both";
}

function isLoadSizeKind(value: string): value is LoadSizeKind {
  return (
    value === "quarter_to_half" ||
    value === "half_to_three_quarters" ||
    value === "three_quarters_to_full" ||
    value === "custom"
  );
}

function isAppointmentServiceType(
  value: string,
): value is AppointmentServiceType {
  return (
    value === "junk_removal" ||
    value === "land_clearing" ||
    value === "demolition" ||
    value === "rental_dumpster"
  );
}

function isLandClearingAccessDifficulty(
  value: string,
): value is LandClearingAccessDifficulty {
  return value === "easy" || value === "moderate" || value === "hard";
}

function isDemolitionType(value: string): value is DemolitionType {
  return (
    value === "shed" ||
    value === "deck" ||
    value === "fence" ||
    value === "interior" ||
    value === "concrete" ||
    value === "other"
  );
}

function isDumpsterSizeKind(value: string): value is DumpsterSizeKind {
  return value === "10_yard" || value === "15_yard" || value === "20_yard";
}

function trimTrailingZeros(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatServiceTypeLabel(value: AppointmentServiceType): string {
  switch (value) {
    case "junk_removal":
      return "Junk removal";
    case "land_clearing":
      return "Land clearing";
    case "demolition":
      return "Demolition";
    case "rental_dumpster":
      return "Rental dumpster";
    default:
      return "Job";
  }
}

function formatLandClearingAccessLabel(
  value: LandClearingAccessDifficulty,
): string {
  switch (value) {
    case "easy":
      return "Easy";
    case "moderate":
      return "Moderate";
    case "hard":
      return "Hard";
    default:
      return value;
  }
}

function formatDemolitionTypeLabel(value: DemolitionType): string {
  switch (value) {
    case "shed":
      return "Shed";
    case "deck":
      return "Deck";
    case "fence":
      return "Fence";
    case "interior":
      return "Interior";
    case "concrete":
      return "Concrete";
    case "other":
      return "Other";
    default:
      return value;
  }
}

function formatDumpsterSizeLabel(value: DumpsterSizeKind): string {
  switch (value) {
    case "10_yard":
      return "10-yard dumpster";
    case "15_yard":
      return "15-yard dumpster";
    case "20_yard":
      return "20-yard dumpster";
    default:
      return value;
  }
}

function formatShortDate(value: string): string {
  const normalized = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00`)
    : new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}
