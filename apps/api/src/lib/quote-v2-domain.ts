import { createHash } from "node:crypto";
import { z } from "zod";

export const QUOTE_V2_SCHEMA_VERSION = 1;
export const QUOTE_V2_CURRENCY = "USD" as const;
export const MAX_QUOTE_LINE_ITEMS = 100;
export const MAX_QUOTE_OPTION_GROUPS = 20;
export const MAX_QUOTE_ADJUSTMENTS = 30;
export const MAX_QUOTE_TOTAL_CENTS = 100_000_000;

export const QuoteDocumentTypeSchema = z.enum([
  "fixed_quote",
  "estimate",
  "range",
]);
export const QuoteAudienceSchema = z.enum(["residential", "commercial"]);
export const QuoteSchedulingModeSchema = z.enum([
  "self_schedule",
  "staff_followup",
  "approval_only",
]);
export const QuoteAggregateStateSchema = z.enum([
  "draft",
  "open",
  "accepted",
  "declined",
  "voided",
  "archived",
]);
export const SalesOpportunityStateSchema = z.enum([
  "open",
  "approved",
  "won",
  "lost",
  "archived",
]);
export const QuoteVersionStateSchema = z.enum([
  "draft",
  "ready",
  "issued",
  "superseded",
  "accepted",
  "expired",
  "declined",
  "voided",
]);

export type QuoteDocumentType = z.infer<typeof QuoteDocumentTypeSchema>;
export type QuoteAudience = z.infer<typeof QuoteAudienceSchema>;
export type QuoteSchedulingMode = z.infer<typeof QuoteSchedulingModeSchema>;
export type QuoteAggregateState = z.infer<typeof QuoteAggregateStateSchema>;
export type QuoteVersionState = z.infer<typeof QuoteVersionStateSchema>;
export type SalesOpportunityState = z.infer<typeof SalesOpportunityStateSchema>;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalBoundedText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .nullable()
    .optional()
    .transform((value) => value || null);

const MoneyCentsSchema = z.number().int().min(0).max(MAX_QUOTE_TOTAL_CENTS);

export const QuotePartySnapshotSchema = z
  .object({
    customerName: boundedText(240),
    companyName: optionalBoundedText(240),
    attentionName: optionalBoundedText(240),
    attentionTitle: optionalBoundedText(160),
    email: z.string().trim().email().max(320).nullable().optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u)
      .nullable()
      .optional(),
    billingAddress: optionalBoundedText(1_000),
    serviceAddress: boundedText(1_000),
    projectName: optionalBoundedText(240),
    purchaseOrder: optionalBoundedText(160),
    reference: optionalBoundedText(160),
    preparerName: boundedText(240),
  })
  .strict();

export const QuoteOptionGroupSchema = z
  .object({
    id: boundedText(80),
    label: boundedText(200),
    mode: z.enum(["single", "multiple"]),
    minimumSelections: z.number().int().min(0).max(100).default(0),
    maximumSelections: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((group, context) => {
    if (group.mode === "single" && group.maximumSelections !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumSelections"],
        message: "A choose-one option group must allow exactly one selection.",
      });
    }
    if (group.minimumSelections > group.maximumSelections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumSelections"],
        message: "Minimum selections cannot exceed maximum selections.",
      });
    }
  });

export const QuoteLineItemSchema = z
  .object({
    id: boundedText(80),
    catalogKey: optionalBoundedText(120),
    name: boundedText(240),
    description: optionalBoundedText(2_000),
    quantity: z.number().positive().max(1_000_000),
    unit: boundedText(40),
    unitPriceMinCents: MoneyCentsSchema,
    unitPriceMaxCents: MoneyCentsSchema.nullable().optional(),
    optionGroupId: optionalBoundedText(80),
    selectedByDefault: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((line, context) => {
    if (!Number.isInteger(line.quantity * 1_000)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "Quantity supports at most three decimal places.",
      });
    }
    if (
      line.unitPriceMaxCents !== null &&
      line.unitPriceMaxCents !== undefined &&
      line.unitPriceMaxCents < line.unitPriceMinCents
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitPriceMaxCents"],
        message: "Maximum unit price cannot be below the minimum price.",
      });
    }
    if (!line.optionGroupId && line.selectedByDefault) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedByDefault"],
        message: "Only optional lines can define a default selection.",
      });
    }
  });

export const QuoteAdjustmentSchema = z
  .object({
    id: boundedText(80),
    kind: z.enum(["discount", "fee", "travel"]),
    label: boundedText(240),
    calculation: z.enum(["fixed", "percentage"]),
    basis: z.enum(["subtotal", "line_items"]).default("subtotal"),
    eligibleLineItemIds: z
      .array(boundedText(80))
      .max(MAX_QUOTE_LINE_ITEMS)
      .default([]),
    amountCents: MoneyCentsSchema.nullable().optional(),
    basisPoints: z.number().int().min(1).max(10_000).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((adjustment, context) => {
    if (
      adjustment.basis === "line_items" &&
      adjustment.eligibleLineItemIds.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eligibleLineItemIds"],
        message: "A line-item adjustment requires at least one eligible line.",
      });
    }
    if (
      adjustment.basis === "subtotal" &&
      adjustment.eligibleLineItemIds.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eligibleLineItemIds"],
        message: "Subtotal adjustments cannot also name eligible lines.",
      });
    }
    if (
      adjustment.calculation === "fixed" &&
      (adjustment.amountCents === null || adjustment.amountCents === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountCents"],
        message: "A fixed adjustment requires an amount.",
      });
    }
    if (
      adjustment.calculation === "percentage" &&
      (adjustment.basisPoints === null || adjustment.basisPoints === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["basisPoints"],
        message: "A percentage adjustment requires basis points.",
      });
    }
    if (
      adjustment.calculation === "fixed" &&
      adjustment.basisPoints !== null &&
      adjustment.basisPoints !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["basisPoints"],
        message: "A fixed adjustment cannot also define a percentage.",
      });
    }
    if (
      adjustment.calculation === "percentage" &&
      adjustment.amountCents !== null &&
      adjustment.amountCents !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountCents"],
        message: "A percentage adjustment cannot also define a fixed amount.",
      });
    }
  });

export const QuoteDepositSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({ mode: z.literal("fixed"), amountCents: MoneyCentsSchema.min(1) })
    .strict(),
  z
    .object({
      mode: z.literal("percentage"),
      basisPoints: z.number().int().min(1).max(10_000),
    })
    .strict(),
]);

export const QuotePricingInputSchema = z
  .object({
    documentType: QuoteDocumentTypeSchema,
    currency: z.literal(QUOTE_V2_CURRENCY).default(QUOTE_V2_CURRENCY),
    lineItems: z.array(QuoteLineItemSchema).min(1).max(MAX_QUOTE_LINE_ITEMS),
    optionGroups: z
      .array(QuoteOptionGroupSchema)
      .max(MAX_QUOTE_OPTION_GROUPS)
      .default([]),
    adjustments: z
      .array(QuoteAdjustmentSchema)
      .max(MAX_QUOTE_ADJUSTMENTS)
      .default([]),
    deposit: QuoteDepositSchema.default({ mode: "none" }),
  })
  .strict();

export type QuotePricingInput = z.input<typeof QuotePricingInputSchema>;
export type QuoteLineItem = z.infer<typeof QuoteLineItemSchema>;
export type QuoteAdjustment = z.infer<typeof QuoteAdjustmentSchema>;
export type QuoteOptionGroup = z.infer<typeof QuoteOptionGroupSchema>;
export type QuoteDeposit = z.infer<typeof QuoteDepositSchema>;

export type QuoteCalculatedLine = QuoteLineItem & {
  selected: boolean;
  amountMinCents: number;
  amountMaxCents: number;
};

export type QuoteCalculatedAdjustment = QuoteAdjustment & {
  eligibleSubtotalMinCents: number;
  eligibleSubtotalMaxCents: number;
  amountMinCents: number;
  amountMaxCents: number;
};

export type QuoteTotals = {
  documentType: QuoteDocumentType;
  currency: typeof QUOTE_V2_CURRENCY;
  lines: QuoteCalculatedLine[];
  adjustments: QuoteCalculatedAdjustment[];
  selectedOptionIds: string[];
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
};

export class QuoteDomainError extends Error {
  readonly code:
    | "invalid_pricing"
    | "invalid_option_selection"
    | "invalid_state_transition"
    | "not_ready";
  readonly fieldErrors: Record<string, string>;

  constructor(
    code: QuoteDomainError["code"],
    message: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "QuoteDomainError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function firstZodErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "quote";
    result[key] ??= issue.message;
  }
  return result;
}

function parsePricingInput(input: unknown) {
  const parsed = QuotePricingInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "Review the quote pricing and try again.",
      firstZodErrors(parsed.error),
    );
  }
  return parsed.data;
}

function roundedRatio(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function calculateLineAmount(quantity: number, unitPriceCents: number): number {
  const quantityMilliunits = Math.round(quantity * 1_000);
  const amount = roundedRatio(quantityMilliunits * unitPriceCents, 1_000);
  if (!Number.isSafeInteger(amount) || amount > MAX_QUOTE_TOTAL_CENTS) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "A quote line exceeds the supported amount.",
    );
  }
  return amount;
}

function calculateAdjustmentAmount(
  adjustment: QuoteAdjustment,
  subtotalCents: number,
): number {
  if (adjustment.calculation === "fixed") {
    return adjustment.amountCents ?? 0;
  }
  return roundedRatio(subtotalCents * (adjustment.basisPoints ?? 0), 10_000);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function validateIds<T extends { id: string }>(
  values: T[],
  field: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) {
      throw new QuoteDomainError(
        "invalid_pricing",
        "Quote identifiers must be unique.",
        { [field]: `Duplicate identifier: ${value.id}` },
      );
    }
    result.set(value.id, value);
  }
  return result;
}

function selectedOptions(
  lines: QuoteLineItem[],
  optionGroups: QuoteOptionGroup[],
  requested: readonly string[] | undefined,
): Set<string> {
  const groupById = validateIds(optionGroups, "optionGroups");
  const lineById = validateIds(lines, "lineItems");
  const optionLines = lines.filter((line) => line.optionGroupId);
  const optionLineIds = new Set(optionLines.map((line) => line.id));
  const requestedIds = requested
    ? [...requested]
    : optionLines
        .filter((line) => line.selectedByDefault)
        .map((line) => line.id);

  if (uniqueValues(requestedIds).length !== requestedIds.length) {
    throw new QuoteDomainError(
      "invalid_option_selection",
      "A quote option cannot be selected more than once.",
      { selectedOptionIds: "Remove duplicate option selections." },
    );
  }

  for (const line of optionLines) {
    if (!groupById.has(line.optionGroupId ?? "")) {
      throw new QuoteDomainError(
        "invalid_pricing",
        "An optional quote line references an unknown option group.",
        { lineItems: `Unknown option group on line ${line.id}.` },
      );
    }
  }
  for (const lineId of requestedIds) {
    if (!lineById.has(lineId) || !optionLineIds.has(lineId)) {
      throw new QuoteDomainError(
        "invalid_option_selection",
        "An unavailable quote option was selected.",
        { selectedOptionIds: `Unknown option: ${lineId}` },
      );
    }
  }

  const result = new Set(requestedIds);
  for (const group of optionGroups) {
    const groupLineIds = optionLines
      .filter((line) => line.optionGroupId === group.id)
      .map((line) => line.id);
    const count = groupLineIds.filter((id) => result.has(id)).length;
    if (
      groupLineIds.length < group.maximumSelections ||
      count < group.minimumSelections ||
      count > group.maximumSelections
    ) {
      throw new QuoteDomainError(
        "invalid_option_selection",
        "Review the selected quote options.",
        {
          selectedOptionIds: `${group.label} requires ${group.minimumSelections}-${group.maximumSelections} selection(s).`,
        },
      );
    }
  }
  return result;
}

export function calculateQuoteV2Totals(
  input: unknown,
  requestedOptionIds?: readonly string[],
): QuoteTotals {
  const parsed = parsePricingInput(input);
  validateIds(parsed.adjustments, "adjustments");
  const selected = selectedOptions(
    parsed.lineItems,
    parsed.optionGroups,
    requestedOptionIds,
  );

  const lines = [...parsed.lineItems]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
    .map((line): QuoteCalculatedLine => {
      const lineSelected = !line.optionGroupId || selected.has(line.id);
      const maximumUnitPrice = line.unitPriceMaxCents ?? line.unitPriceMinCents;
      return {
        ...line,
        selected: lineSelected,
        amountMinCents: lineSelected
          ? calculateLineAmount(line.quantity, line.unitPriceMinCents)
          : 0,
        amountMaxCents: lineSelected
          ? calculateLineAmount(line.quantity, maximumUnitPrice)
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
  if (subtotalMinCents > MAX_QUOTE_TOTAL_CENTS) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "The quote subtotal exceeds the supported amount.",
    );
  }

  const adjustments = [...parsed.adjustments]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
    .map((adjustment): QuoteCalculatedAdjustment => {
      if (
        uniqueValues(adjustment.eligibleLineItemIds).length !==
        adjustment.eligibleLineItemIds.length
      ) {
        throw new QuoteDomainError(
          "invalid_pricing",
          "Adjustment eligibility cannot contain duplicate lines.",
          { adjustments: `Remove duplicate lines from ${adjustment.label}.` },
        );
      }
      const eligibleLines =
        adjustment.basis === "subtotal"
          ? lines
          : adjustment.eligibleLineItemIds.map((lineId) => {
              const line = lines.find((candidate) => candidate.id === lineId);
              if (!line) {
                throw new QuoteDomainError(
                  "invalid_pricing",
                  "An adjustment references an unknown quote line.",
                  {
                    adjustments: `Unknown line ${lineId} on ${adjustment.label}.`,
                  },
                );
              }
              return line;
            });
      const eligibleSubtotalMinCents = eligibleLines.reduce(
        (sum, line) => sum + line.amountMinCents,
        0,
      );
      const eligibleSubtotalMaxCents = eligibleLines.reduce(
        (sum, line) => sum + line.amountMaxCents,
        0,
      );
      return {
        ...adjustment,
        eligibleSubtotalMinCents,
        eligibleSubtotalMaxCents,
        amountMinCents: calculateAdjustmentAmount(
          adjustment,
          eligibleSubtotalMinCents,
        ),
        amountMaxCents: calculateAdjustmentAmount(
          adjustment,
          eligibleSubtotalMaxCents,
        ),
      };
    });

  const byKind = (kind: QuoteAdjustment["kind"], side: "min" | "max") =>
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

  const discountMinCents = byKind("discount", "min");
  const discountMaxCents = byKind("discount", "max");
  const feeMinCents = byKind("fee", "min") + byKind("travel", "min");
  const feeMaxCents = byKind("fee", "max") + byKind("travel", "max");
  const invalidDiscount = adjustments.some(
    (adjustment) =>
      adjustment.kind === "discount" &&
      (adjustment.amountMinCents > adjustment.eligibleSubtotalMinCents ||
        adjustment.amountMaxCents > adjustment.eligibleSubtotalMaxCents),
  );
  if (invalidDiscount) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "Discounts cannot exceed the eligible subtotal.",
      { adjustments: "Reduce the quote discount." },
    );
  }

  const totalMinCents = subtotalMinCents - discountMinCents + feeMinCents;
  const totalMaxCents = subtotalMaxCents - discountMaxCents + feeMaxCents;
  if (
    totalMinCents < 0 ||
    totalMaxCents < totalMinCents ||
    totalMaxCents > MAX_QUOTE_TOTAL_CENTS
  ) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "The quote totals are not valid.",
      { total: "Review the quote range and adjustments." },
    );
  }

  if (parsed.documentType !== "range" && totalMinCents !== totalMaxCents) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "Only range documents can contain low and high prices.",
      { documentType: "Choose Range or use one price for every line." },
    );
  }
  if (parsed.documentType === "range" && totalMaxCents <= totalMinCents) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "A range must have a high total above its low total.",
      { total: "Increase at least one maximum price." },
    );
  }
  if (parsed.documentType === "range" && parsed.deposit.mode === "percentage") {
    throw new QuoteDomainError(
      "invalid_pricing",
      "Range documents require a fixed deposit.",
      { deposit: "Choose no deposit or a fixed deposit amount." },
    );
  }

  const depositCents =
    parsed.deposit.mode === "none"
      ? 0
      : parsed.deposit.mode === "fixed"
        ? parsed.deposit.amountCents
        : roundedRatio(totalMinCents * parsed.deposit.basisPoints, 10_000);
  if (depositCents > totalMinCents) {
    throw new QuoteDomainError(
      "invalid_pricing",
      "The deposit cannot exceed the minimum quote total.",
      { deposit: "Reduce the deposit amount." },
    );
  }

  return {
    documentType: parsed.documentType,
    currency: parsed.currency,
    lines,
    adjustments,
    selectedOptionIds: [...selected].sort(),
    subtotalMinCents,
    subtotalMaxCents,
    discountMinCents,
    discountMaxCents,
    feeMinCents,
    feeMaxCents,
    totalMinCents,
    totalMaxCents,
    depositCents,
    balanceMinCents: totalMinCents - depositCents,
    balanceMaxCents: totalMaxCents - depositCents,
  };
}

export function assertQuoteReadyForIssue(input: {
  pricing: unknown;
  parties: unknown;
  scope: string | null | undefined;
  terms: string | null | undefined;
  validityDays: number;
  selectedOptionIds?: readonly string[];
}): { totals: QuoteTotals; parties: z.infer<typeof QuotePartySnapshotSchema> } {
  const parties = QuotePartySnapshotSchema.safeParse(input.parties);
  const fieldErrors: Record<string, string> = {};
  if (!parties.success) {
    Object.assign(fieldErrors, firstZodErrors(parties.error));
  }
  if (!input.scope?.trim())
    fieldErrors["scope"] = "Add a customer-facing scope.";
  if (!input.terms?.trim())
    fieldErrors["terms"] = "Select or enter proposal terms.";
  if (
    !Number.isInteger(input.validityDays) ||
    input.validityDays < 1 ||
    input.validityDays > 120
  ) {
    fieldErrors["validityDays"] = "Validity must be between 1 and 120 days.";
  }

  let totals: QuoteTotals | null = null;
  try {
    totals = calculateQuoteV2Totals(input.pricing, input.selectedOptionIds);
    if (totals.totalMinCents <= 0) {
      fieldErrors["total"] = "An issued proposal must have a positive total.";
    }
  } catch (error) {
    if (error instanceof QuoteDomainError) {
      Object.assign(fieldErrors, error.fieldErrors);
      fieldErrors["pricing"] ??= error.message;
    } else {
      throw error;
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !parties.success || !totals) {
    throw new QuoteDomainError(
      "not_ready",
      "Complete the proposal readiness checklist before issuing it.",
      fieldErrors,
    );
  }
  return { totals, parties: parties.data };
}

const AGGREGATE_TRANSITIONS: Record<
  QuoteAggregateState,
  QuoteAggregateState[]
> = {
  draft: ["open", "voided", "archived"],
  open: ["accepted", "declined", "voided", "archived"],
  accepted: ["archived"],
  declined: ["archived"],
  voided: ["archived"],
  archived: [],
};

const VERSION_TRANSITIONS: Record<QuoteVersionState, QuoteVersionState[]> = {
  draft: ["ready", "voided"],
  ready: ["issued", "voided"],
  issued: ["superseded", "accepted", "expired", "declined", "voided"],
  superseded: [],
  accepted: [],
  expired: [],
  declined: [],
  voided: [],
};

const OPPORTUNITY_TRANSITIONS: Record<
  SalesOpportunityState,
  SalesOpportunityState[]
> = {
  open: ["approved", "lost", "archived"],
  approved: ["won", "lost", "archived"],
  won: ["archived"],
  lost: ["archived"],
  archived: [],
};

export function assertQuoteAggregateTransition(
  from: QuoteAggregateState,
  to: QuoteAggregateState,
): void {
  if (!AGGREGATE_TRANSITIONS[from].includes(to)) {
    throw new QuoteDomainError(
      "invalid_state_transition",
      `Quote state cannot change from ${from} to ${to}.`,
    );
  }
}

export function assertQuoteVersionTransition(
  from: QuoteVersionState,
  to: QuoteVersionState,
): void {
  if (!VERSION_TRANSITIONS[from].includes(to)) {
    throw new QuoteDomainError(
      "invalid_state_transition",
      `Quote version cannot change from ${from} to ${to}.`,
    );
  }
}

export function assertSalesOpportunityTransition(
  from: SalesOpportunityState,
  to: SalesOpportunityState,
): void {
  if (!OPPORTUNITY_TRANSITIONS[from].includes(to)) {
    throw new QuoteDomainError(
      "invalid_state_transition",
      `Opportunity state cannot change from ${from} to ${to}.`,
    );
  }
}

export function deriveContactOpportunityRollup(
  states: readonly SalesOpportunityState[],
): "open" | "won" | "lost" | "none" {
  const activeStates = states.filter((state) => state !== "archived");
  if (activeStates.some((state) => state === "open" || state === "approved")) {
    return "open";
  }
  if (activeStates.some((state) => state === "won")) return "won";
  if (
    activeStates.length > 0 &&
    activeStates.every((state) => state === "lost")
  ) {
    return "lost";
  }
  return "none";
}

export const QuoteCapabilityActionSchema = z.enum([
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
export type QuoteCapabilityAction = z.infer<typeof QuoteCapabilityActionSchema>;

export function resolveQuoteAllowedActions(input: {
  aggregateState: QuoteAggregateState;
  versionState: QuoteVersionState;
  capabilityActions: readonly QuoteCapabilityAction[];
  actionExpiresAt: Date | null;
  readExpiresAt: Date;
  revokedAt: Date | null;
  hasOpenChangeRequest: boolean;
  requiresDeposit: boolean;
  depositCaptured: boolean;
  schedulingMode: QuoteSchedulingMode;
  now?: Date;
}): QuoteCapabilityAction[] {
  const now = input.now ?? new Date();
  if (input.revokedAt || input.readExpiresAt <= now) return [];
  const granted = new Set(input.capabilityActions);
  const result: QuoteCapabilityAction[] = [];
  if (granted.has("view")) result.push("view");
  if (granted.has("pdf")) result.push("pdf");

  const actionable =
    input.aggregateState === "open" &&
    input.versionState === "issued" &&
    (!input.actionExpiresAt || input.actionExpiresAt > now) &&
    !input.hasOpenChangeRequest;
  if (actionable) {
    for (const action of ["change", "accept", "decline"] as const) {
      if (granted.has(action)) result.push(action);
    }
    if (input.schedulingMode === "self_schedule") {
      if (granted.has("availability")) result.push("availability");
      if (granted.has("hold")) result.push("hold");
    }
    return result;
  }

  const accepted =
    input.aggregateState === "accepted" &&
    input.versionState === "accepted" &&
    (!input.actionExpiresAt || input.actionExpiresAt > now) &&
    !input.hasOpenChangeRequest;
  if (!accepted) return result;
  if (input.schedulingMode === "self_schedule") {
    if (granted.has("availability")) result.push("availability");
    if (granted.has("hold")) result.push("hold");
  }
  if (input.requiresDeposit && !input.depositCaptured) {
    if (granted.has("checkout")) result.push("checkout");
  } else if (input.schedulingMode === "self_schedule" && granted.has("book")) {
    result.push("book");
  }
  return result;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalQuoteJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function hashQuoteContent(value: unknown): string {
  return createHash("sha256").update(canonicalQuoteJson(value)).digest("hex");
}
