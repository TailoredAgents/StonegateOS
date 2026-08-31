export type QuoteV2DocumentType = "fixed_quote" | "estimate" | "range";
export type QuoteV2Audience = "residential" | "commercial";
export type QuoteV2SchedulingMode =
  | "self_schedule"
  | "staff_followup"
  | "approval_only";

export type QuoteV2CapabilityAction =
  | "view"
  | "pdf"
  | "change"
  | "refresh"
  | "accept"
  | "decline"
  | "availability"
  | "hold"
  | "checkout"
  | "book";

export interface QuoteV2PartySnapshot {
  customerName: string;
  companyName?: string | null;
  attentionName?: string | null;
  attentionTitle?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  billingAddress?: string | null;
  serviceAddress: string;
  projectName?: string | null;
  purchaseOrder?: string | null;
  reference?: string | null;
  preparerName: string;
}

export interface QuoteV2IssuerSnapshot {
  legalName: string;
  displayName: string;
  address: string;
  email: string;
  phoneE164: string;
  website?: string | null;
  logoAssetId?: string | null;
  supportMessage?: string | null;
}

export interface QuoteV2OptionGroup {
  id: string;
  label: string;
  mode: "single" | "multiple";
  minimumSelections: number;
  maximumSelections: number;
}

export interface QuoteV2LineItem {
  id: string;
  catalogKey?: string | null;
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unitPriceMinCents: number;
  unitPriceMaxCents?: number | null;
  optionGroupId?: string | null;
  selectedByDefault: boolean;
  displayOrder: number;
}

export interface QuoteV2Adjustment {
  id: string;
  kind: "discount" | "fee" | "travel";
  label: string;
  calculation: "fixed" | "percentage";
  basis: "subtotal" | "line_items";
  eligibleLineItemIds: string[];
  amountCents?: number | null;
  basisPoints?: number | null;
  displayOrder: number;
}

export type QuoteV2Deposit =
  | { mode: "none" }
  | { mode: "fixed"; amountCents: number }
  | { mode: "percentage"; basisPoints: number };

export interface QuoteV2DocumentSnapshot {
  schemaVersion: 1;
  documentType: QuoteV2DocumentType;
  audience: QuoteV2Audience;
  schedulingMode: QuoteV2SchedulingMode;
  parties: QuoteV2PartySnapshot;
  issuer: QuoteV2IssuerSnapshot;
  scope: string;
  inclusions: string[];
  exclusions: string[];
  assumptions: string[];
  pricing: {
    documentType: QuoteV2DocumentType;
    currency: "USD";
    lineItems: QuoteV2LineItem[];
    optionGroups: QuoteV2OptionGroup[];
    adjustments: QuoteV2Adjustment[];
    deposit: QuoteV2Deposit;
  };
  terms: {
    templateId?: string | null;
    templateVersion: string;
    terms: string;
    paymentTerms: string;
    changeOrderRules: string;
    validityDays: number;
    consentVersion: string;
  };
  estimatedDurationMinutes: number;
  serviceZoneId?: string | null;
  serviceZoneConfirmed: boolean;
}

export interface QuoteV2Totals {
  subtotalMinCents: number;
  subtotalMaxCents: number;
  discountMinCents: number;
  discountMaxCents: number;
  feeMinCents: number;
  feeMaxCents: number;
  totalMinCents: number;
  totalMaxCents: number;
  depositCents: number;
  balanceMinCents: number;
  balanceMaxCents: number;
}

export interface QuoteV2PublicAttachment {
  id: string;
  purpose: "scope_evidence" | "site_plan" | "specification" | "terms" | "other";
  caption?: string | null;
  fileName: string;
  mediaType: string;
  displayOrder: number;
}

export interface QuoteV2PublicAppointment {
  id: string;
  status: "requested" | "confirmed" | "canceled" | "completed";
  startAt: string;
  endAt: string;
  timezone: string;
  durationMinutes: number;
  promisedArrivalWindow: {
    startAt: string;
    endAt: string;
  } | null;
}

export interface QuoteV2AppointmentWindowLabel {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  spansLocalDates: boolean;
}

export interface QuoteV2PublicEnvelope {
  quoteId: string;
  versionId: string;
  versionNumber: number;
  quoteNumber: string;
  lifecycleState: string;
  displayState: string;
  document: QuoteV2DocumentSnapshot;
  selectedOptionIds: string[];
  totals: QuoteV2Totals;
  issuedAt: string;
  expiresAt: string;
  allowedActions: QuoteV2CapabilityAction[];
  acceptedResponseId: string | null;
  acceptedAppointmentId: string | null;
  appointment: QuoteV2PublicAppointment | null;
  /** Optional contract extension populated with authorized proxy URLs only. */
  attachments?: QuoteV2PublicAttachment[];
}

export interface QuoteV2CalculatedLine extends QuoteV2LineItem {
  selected: boolean;
  amountMinCents: number;
  amountMaxCents: number;
}

export interface QuoteV2CalculatedAdjustment extends QuoteV2Adjustment {
  amountMinCents: number;
  amountMaxCents: number;
}

export interface QuoteV2LivePricing {
  valid: boolean;
  errors: Record<string, string>;
  selectedOptionIds: string[];
  lines: QuoteV2CalculatedLine[];
  adjustments: QuoteV2CalculatedAdjustment[];
  totals: QuoteV2Totals;
}

export interface QuoteV2Slot {
  startAt: string;
  endAt: string;
  label: string;
}

export type QuoteV2AvailabilityState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "available";
      recommended: QuoteV2Slot[];
      days: Array<{ date: string; slots: QuoteV2Slot[] }>;
      timezone: string;
      arrivalWindowMeaning: string;
    }
  | { kind: "empty"; timezone: string; arrivalWindowMeaning: string }
  | { kind: "unavailable"; message: string };

const CAPABILITY_ACTIONS = new Set<QuoteV2CapabilityAction>([
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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && record[key] !== "";
}

function isQuoteV2Totals(value: unknown): value is QuoteV2Totals {
  if (!isRecord(value)) return false;
  return [
    "subtotalMinCents",
    "subtotalMaxCents",
    "discountMinCents",
    "discountMaxCents",
    "feeMinCents",
    "feeMaxCents",
    "totalMinCents",
    "totalMaxCents",
    "depositCents",
    "balanceMinCents",
    "balanceMaxCents",
  ].every((key) => isFiniteInteger(value[key]) && Number(value[key]) >= 0);
}

function isQuoteV2Document(value: unknown): value is QuoteV2DocumentSnapshot {
  if (!isRecord(value) || value["schemaVersion"] !== 1) return false;
  const parties = value["parties"];
  const issuer = value["issuer"];
  const pricing = value["pricing"];
  const terms = value["terms"];
  return (
    ["fixed_quote", "estimate", "range"].includes(
      String(value["documentType"]),
    ) &&
    ["residential", "commercial"].includes(String(value["audience"])) &&
    ["self_schedule", "staff_followup", "approval_only"].includes(
      String(value["schedulingMode"]),
    ) &&
    hasString(value, "scope") &&
    isRecord(parties) &&
    hasString(parties, "customerName") &&
    hasString(parties, "serviceAddress") &&
    hasString(parties, "preparerName") &&
    isRecord(issuer) &&
    hasString(issuer, "displayName") &&
    hasString(issuer, "email") &&
    hasString(issuer, "phoneE164") &&
    isRecord(pricing) &&
    Array.isArray(pricing["lineItems"]) &&
    Array.isArray(pricing["optionGroups"]) &&
    Array.isArray(pricing["adjustments"]) &&
    isRecord(terms) &&
    hasString(terms, "terms") &&
    hasString(terms, "consentVersion")
  );
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSupportedTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isQuoteV2Appointment(
  value: unknown,
): value is QuoteV2PublicAppointment {
  if (!isRecord(value)) return false;
  const window = value["promisedArrivalWindow"];
  const validWindow =
    window === null ||
    (isRecord(window) &&
      isIsoDateTime(window["startAt"]) &&
      isIsoDateTime(window["endAt"]) &&
      Date.parse(window["endAt"]) > Date.parse(window["startAt"]));
  return (
    hasString(value, "id") &&
    ["requested", "confirmed", "canceled", "completed"].includes(
      String(value["status"]),
    ) &&
    isIsoDateTime(value["startAt"]) &&
    isIsoDateTime(value["endAt"]) &&
    Date.parse(value["endAt"]) > Date.parse(value["startAt"]) &&
    isSupportedTimezone(value["timezone"]) &&
    isFiniteInteger(value["durationMinutes"]) &&
    Number(value["durationMinutes"]) > 0 &&
    Number(value["durationMinutes"]) <= 30 * 24 * 60 &&
    validWindow
  );
}

export function isQuoteV2PublicEnvelope(
  value: unknown,
): value is QuoteV2PublicEnvelope {
  if (!isRecord(value)) return false;
  const attachments = value["attachments"];
  const validAttachments =
    attachments === undefined ||
    (Array.isArray(attachments) &&
      attachments.length <= 10 &&
      attachments.every(
        (candidate) =>
          isRecord(candidate) &&
          hasString(candidate, "id") &&
          hasString(candidate, "purpose") &&
          hasString(candidate, "fileName") &&
          hasString(candidate, "mediaType") &&
          isFiniteInteger(candidate["displayOrder"]) &&
          Number(candidate["displayOrder"]) >= 0,
      ));
  const acceptedResponseId = value["acceptedResponseId"];
  const acceptedAppointmentId = value["acceptedAppointmentId"];
  const appointment = value["appointment"];
  const validAppointmentBinding =
    (acceptedResponseId === null || typeof acceptedResponseId === "string") &&
    (acceptedAppointmentId === null ||
      typeof acceptedAppointmentId === "string") &&
    (appointment === null || isQuoteV2Appointment(appointment)) &&
    Boolean(acceptedAppointmentId) === Boolean(appointment) &&
    (!appointment ||
      (appointment.id === acceptedAppointmentId &&
        typeof acceptedResponseId === "string"));
  return (
    hasString(value, "quoteId") &&
    hasString(value, "versionId") &&
    hasString(value, "quoteNumber") &&
    hasString(value, "lifecycleState") &&
    hasString(value, "displayState") &&
    isFiniteInteger(value["versionNumber"]) &&
    Number(value["versionNumber"]) > 0 &&
    hasString(value, "issuedAt") &&
    hasString(value, "expiresAt") &&
    isQuoteV2Document(value["document"]) &&
    Array.isArray(value["selectedOptionIds"]) &&
    value["selectedOptionIds"].every((id) => typeof id === "string") &&
    Array.isArray(value["allowedActions"]) &&
    value["allowedActions"].every(
      (action) =>
        typeof action === "string" &&
        CAPABILITY_ACTIONS.has(action as QuoteV2CapabilityAction),
    ) &&
    isQuoteV2Totals(value["totals"]) &&
    validAttachments &&
    validAppointmentBinding
  );
}

/** Accept the canonical envelope plus the two rollout wrapper shapes. */
export function normalizeQuoteV2PublicPayload(
  value: unknown,
): QuoteV2PublicEnvelope | null {
  if (isQuoteV2PublicEnvelope(value)) return value;
  if (!isRecord(value)) return null;
  if (isQuoteV2PublicEnvelope(value["quote"])) return value["quote"];
  const data = value["data"];
  if (isQuoteV2PublicEnvelope(data)) return data;
  if (isRecord(data) && isQuoteV2PublicEnvelope(data["quote"])) {
    return data["quote"];
  }
  return null;
}

/**
 * Formats persisted appointment instants in their snapshotted scheduling
 * timezone. The end date is carried separately so cross-midnight windows can
 * never be mistaken for an earlier same-day time, including around DST.
 */
export function formatQuoteV2AppointmentWindow(
  startAt: string,
  endAt: string,
  timezone: string,
): QuoteV2AppointmentWindowLabel {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const dateKeyFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return {
    startDate: dateFormatter.format(start),
    startTime: timeFormatter.format(start),
    endDate: dateFormatter.format(end),
    endTime: timeFormatter.format(end),
    spansLocalDates:
      dateKeyFormatter.format(start) !== dateKeyFormatter.format(end),
  };
}

function roundedRatio(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function lineAmount(quantity: number, unitPriceCents: number): number {
  return roundedRatio(Math.round(quantity * 1_000) * unitPriceCents, 1_000);
}

function adjustmentAmount(
  adjustment: QuoteV2Adjustment,
  subtotal: number,
): number {
  return adjustment.calculation === "fixed"
    ? (adjustment.amountCents ?? 0)
    : roundedRatio(subtotal * (adjustment.basisPoints ?? 0), 10_000);
}

function emptyTotals(): QuoteV2Totals {
  return {
    subtotalMinCents: 0,
    subtotalMaxCents: 0,
    discountMinCents: 0,
    discountMaxCents: 0,
    feeMinCents: 0,
    feeMaxCents: 0,
    totalMinCents: 0,
    totalMaxCents: 0,
    depositCents: 0,
    balanceMinCents: 0,
    balanceMaxCents: 0,
  };
}

/**
 * Mirrors the integer-cent server algorithm for immediate option feedback.
 * The decision endpoint always recalculates and remains authoritative.
 */
export function calculateQuoteV2LivePricing(
  envelope: QuoteV2PublicEnvelope,
  requestedOptionIds: readonly string[],
): QuoteV2LivePricing {
  const pricing = envelope.document.pricing;
  const errors: Record<string, string> = {};
  const optionLines = pricing.lineItems.filter((line) => line.optionGroupId);
  const optionIds = new Set(optionLines.map((line) => line.id));
  const selected = new Set<string>();

  for (const id of requestedOptionIds) {
    if (!optionIds.has(id)) {
      errors["selectedOptionIds"] = "An unavailable option was selected.";
      continue;
    }
    selected.add(id);
  }
  if (selected.size !== requestedOptionIds.length) {
    errors["selectedOptionIds"] ??= "Select each option only once.";
  }

  for (const group of pricing.optionGroups) {
    const count = optionLines.filter(
      (line) => line.optionGroupId === group.id && selected.has(line.id),
    ).length;
    if (count < group.minimumSelections || count > group.maximumSelections) {
      errors[group.id] =
        `${group.label} requires ${group.minimumSelections}–${group.maximumSelections} selection${group.maximumSelections === 1 ? "" : "s"}.`;
    }
  }

  const lines = [...pricing.lineItems]
    .sort((left, right) =>
      left.displayOrder === right.displayOrder
        ? left.id.localeCompare(right.id)
        : left.displayOrder - right.displayOrder,
    )
    .map((line): QuoteV2CalculatedLine => {
      const lineSelected = !line.optionGroupId || selected.has(line.id);
      return {
        ...line,
        selected: lineSelected,
        amountMinCents: lineSelected
          ? lineAmount(line.quantity, line.unitPriceMinCents)
          : 0,
        amountMaxCents: lineSelected
          ? lineAmount(
              line.quantity,
              line.unitPriceMaxCents ?? line.unitPriceMinCents,
            )
          : 0,
      };
    });

  const subtotalMinCents = lines.reduce(
    (sum, line) => sum + line.amountMinCents,
    0,
  );
  const subtotalMaxCents = lines.reduce(
    (sum, line) => sum + line.amountMaxCents,
    0,
  );
  const adjustments = [...pricing.adjustments]
    .sort((left, right) =>
      left.displayOrder === right.displayOrder
        ? left.id.localeCompare(right.id)
        : left.displayOrder - right.displayOrder,
    )
    .map((adjustment): QuoteV2CalculatedAdjustment => {
      const eligible =
        adjustment.basis === "subtotal"
          ? lines
          : lines.filter((line) =>
              adjustment.eligibleLineItemIds.includes(line.id),
            );
      const eligibleMin = eligible.reduce(
        (sum, line) => sum + line.amountMinCents,
        0,
      );
      const eligibleMax = eligible.reduce(
        (sum, line) => sum + line.amountMaxCents,
        0,
      );
      return {
        ...adjustment,
        amountMinCents: adjustmentAmount(adjustment, eligibleMin),
        amountMaxCents: adjustmentAmount(adjustment, eligibleMax),
      };
    });

  const sumKind = (kind: QuoteV2Adjustment["kind"], side: "min" | "max") =>
    adjustments
      .filter((adjustment) => adjustment.kind === kind)
      .reduce(
        (sum, adjustment) =>
          sum +
          (side === "min"
            ? adjustment.amountMinCents
            : adjustment.amountMaxCents),
        0,
      );
  const discountMinCents = sumKind("discount", "min");
  const discountMaxCents = sumKind("discount", "max");
  const feeMinCents = sumKind("fee", "min") + sumKind("travel", "min");
  const feeMaxCents = sumKind("fee", "max") + sumKind("travel", "max");
  const totalMinCents = subtotalMinCents - discountMinCents + feeMinCents;
  const totalMaxCents = subtotalMaxCents - discountMaxCents + feeMaxCents;
  const deposit = pricing.deposit;
  const depositCents =
    deposit.mode === "none"
      ? 0
      : deposit.mode === "fixed"
        ? deposit.amountCents
        : roundedRatio(totalMinCents * deposit.basisPoints, 10_000);

  if (totalMinCents <= 0 || totalMaxCents < totalMinCents) {
    errors["total"] = "This option combination does not produce a valid total.";
  }
  if (depositCents > totalMinCents) {
    errors["deposit"] =
      "This option combination is below the required deposit.";
  }

  const totals =
    totalMinCents >= 0 && totalMaxCents >= 0
      ? {
          subtotalMinCents,
          subtotalMaxCents,
          discountMinCents,
          discountMaxCents,
          feeMinCents,
          feeMaxCents,
          totalMinCents,
          totalMaxCents,
          depositCents,
          balanceMinCents: Math.max(0, totalMinCents - depositCents),
          balanceMaxCents: Math.max(0, totalMaxCents - depositCents),
        }
      : emptyTotals();

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    selectedOptionIds: [...selected].sort(),
    lines,
    adjustments,
    totals,
  };
}

export function formatQuoteV2Usd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatQuoteV2Amount(
  documentType: QuoteV2DocumentType,
  minimumCents: number,
  maximumCents: number,
): string {
  return documentType === "range" && maximumCents !== minimumCents
    ? `${formatQuoteV2Usd(minimumCents)}–${formatQuoteV2Usd(maximumCents)}`
    : formatQuoteV2Usd(minimumCents);
}

export function quoteV2DocumentLabel(type: QuoteV2DocumentType): string {
  if (type === "fixed_quote") return "Fixed quote";
  if (type === "estimate") return "Estimate";
  return "Price range";
}

export function quoteV2ConsentSummary(type: QuoteV2DocumentType): string {
  if (type === "fixed_quote") {
    return "I approve the firm total for the listed scope and selected options.";
  }
  if (type === "estimate") {
    return "I acknowledge this is a non-binding estimate and approve work under the stated change and final-pricing rules.";
  }
  return "I acknowledge this non-binding price range and approve work under the stated change and final-pricing rules.";
}

export function quoteV2ReadOnlyMessage(
  envelope: QuoteV2PublicEnvelope,
): string | null {
  const actions = new Set(envelope.allowedActions);
  if (
    actions.has("accept") ||
    actions.has("refresh") ||
    actions.has("checkout") ||
    actions.has("book")
  ) {
    return null;
  }
  if (envelope.appointment?.status === "requested") {
    return "Approved. Your requested appointment time is recorded and awaiting final confirmation.";
  }
  if (envelope.appointment?.status === "confirmed") {
    return "Approved and booked. Your confirmed appointment details and proposal remain available here for reference.";
  }
  if (envelope.appointment?.status === "canceled") {
    return "This appointment is no longer active. Contact the team for scheduling support; this proposal remains available for reference.";
  }
  if (envelope.appointment?.status === "completed") {
    return "Service completed. Your appointment details and confirmed proposal remain available for reference.";
  }
  const state =
    `${envelope.lifecycleState} ${envelope.displayState}`.toLowerCase();
  if (state.includes("superseded")) {
    return "A newer version of this proposal is available. This version remains available for your records, but it cannot be approved.";
  }
  if (state.includes("change")) {
    return "Your updated proposal request is being reviewed. Approval, payment, and scheduling remain paused until the team responds.";
  }
  if (state.includes("expired")) {
    return "This proposal has expired and is now read-only.";
  }
  if (state.includes("declined")) {
    return "This proposal was declined and is retained as a read-only record.";
  }
  if (state.includes("void")) {
    return "This proposal was voided and can no longer be acted on.";
  }
  if (state.includes("accepted") || state.includes("approved")) {
    return "Approved. The team will follow up with the next fulfillment step.";
  }
  return "This proposal is available for reference, but this link does not permit a response.";
}

function isQuoteV2Slot(value: unknown): value is QuoteV2Slot {
  return (
    isRecord(value) &&
    isIsoDateTime(value["startAt"]) &&
    isIsoDateTime(value["endAt"]) &&
    Date.parse(value["endAt"]) > Date.parse(value["startAt"]) &&
    hasString(value, "label") &&
    String(value["label"]).length <= 160
  );
}

function unavailableQuoteV2Availability(): QuoteV2AvailabilityState {
  return {
    kind: "unavailable",
    message:
      "We could not check the calendar. This does not mean appointment windows are full.",
  };
}

export function normalizeQuoteV2Availability(
  value: unknown,
): QuoteV2AvailabilityState {
  if (!isRecord(value) || !isRecord(value["availability"])) {
    return unavailableQuoteV2Availability();
  }
  const availability = value["availability"];
  const state = availability["state"];
  const recommendedSlots = availability["recommendedSlots"];
  const rawDays = availability["days"];
  const responseId = availability["responseId"];
  const arrivalWindowMeaning = availability["arrivalWindowMeaning"];
  if (
    (state !== "available" && state !== "empty") ||
    !hasString(availability, "quoteId") ||
    !hasString(availability, "versionId") ||
    (responseId !== null && typeof responseId !== "string") ||
    !isSupportedTimezone(availability["timezone"]) ||
    !isFiniteInteger(availability["durationMinutes"]) ||
    Number(availability["durationMinutes"]) < 1 ||
    Number(availability["durationMinutes"]) > 30 * 24 * 60 ||
    !isFiniteInteger(availability["travelBufferMinutes"]) ||
    Number(availability["travelBufferMinutes"]) < 0 ||
    Number(availability["travelBufferMinutes"]) > 24 * 60 ||
    typeof arrivalWindowMeaning !== "string" ||
    !arrivalWindowMeaning.trim() ||
    arrivalWindowMeaning.length > 500 ||
    !isIsoDateTime(availability["generatedAt"]) ||
    !Array.isArray(recommendedSlots) ||
    recommendedSlots.length > 3 ||
    !recommendedSlots.every(isQuoteV2Slot) ||
    !Array.isArray(rawDays) ||
    rawDays.length > 60
  ) {
    return unavailableQuoteV2Availability();
  }
  const days: Array<{ date: string; slots: QuoteV2Slot[] }> = [];
  for (const rawDay of rawDays) {
    if (
      !isRecord(rawDay) ||
      typeof rawDay["date"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(rawDay["date"]) ||
      !Array.isArray(rawDay["slots"]) ||
      rawDay["slots"].length > 100 ||
      !rawDay["slots"].every(isQuoteV2Slot)
    ) {
      return unavailableQuoteV2Availability();
    }
    days.push({ date: String(rawDay["date"]), slots: rawDay["slots"] });
  }
  const hasAnySlot =
    recommendedSlots.length > 0 || days.some((day) => day.slots.length > 0);
  if (
    (state === "available" && recommendedSlots.length === 0) ||
    (state === "empty" && hasAnySlot)
  ) {
    return unavailableQuoteV2Availability();
  }
  const timezone = String(availability["timezone"]);
  return state === "available"
    ? {
        kind: "available",
        recommended: recommendedSlots,
        days,
        timezone,
        arrivalWindowMeaning,
      }
    : { kind: "empty", timezone, arrivalWindowMeaning };
}
