export type LeadSourceType = "google" | "facebook" | "team_member" | "referral";
export type PriceInputMode = "range" | "exact" | "both";
export type LoadSizeKind =
  | "quarter_to_half"
  | "half_to_three_quarters"
  | "three_quarters_to_full"
  | "custom";

export type AppointmentBookingDetails = {
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
  loadSize: {
    kind: LoadSizeKind;
    customLoads?: number | null;
  };
};

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

  const modeRaw = readText(formData.get("priceInputMode"));
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
      source: sourceResult.value,
      pricing: {
        mode: modeRaw,
        rangeMinCents:
          modeRaw === "range" || modeRaw === "both" ? rangeMinCents : null,
        rangeMaxCents:
          modeRaw === "range" || modeRaw === "both" ? rangeMaxCents : null,
      },
      loadSize: {
        kind: loadSizeRaw,
        customLoads,
      },
    },
  };
}

export function formatStoredContactSource(
  value: string | null | undefined,
  teamMemberNameById?: Map<string, string>,
): string | null {
  const parsed = parseStoredContactSource(value);
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

function parseStoredContactSource(
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
  return Math.round(parsed * 100) / 100;
}

function trimTrailingZeros(value: number): string {
  return value % 1 === 0
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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
