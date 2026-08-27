import { z } from "zod";

export const MAX_RECEIPT_MONEY_CENTS = 100_000_000;
export const DEFAULT_RECEIPT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_FUZZY_DUPLICATE_WINDOW_DAYS = 3;

const MAX_LINE_ITEMS = 100;
const MAX_WARNINGS = 20;
const MAX_ALLOCATIONS = 32;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/iu;
const CATEGORY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

const nullableConfidenceSchema = z.number().finite().min(0).max(1).nullable();
const nullableCategoryIdSchema = z
  .string()
  .trim()
  .regex(CATEGORY_ID_PATTERN)
  .nullable();

function isCalendarDate(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100) return false;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const nullableDateOnlySchema = z
  .string()
  .trim()
  .refine(isCalendarDate, "Use a real calendar date in YYYY-MM-DD format.")
  .nullable();

const ExpenseReceiptLineItemSchema = z
  .object({
    description: z.string().trim().min(1).max(240),
    amountCents: z
      .number()
      .int()
      .min(-MAX_RECEIPT_MONEY_CENTS)
      .max(MAX_RECEIPT_MONEY_CENTS),
  })
  .strict();

export type ExpenseReceiptLineItem = z.infer<
  typeof ExpenseReceiptLineItemSchema
>;

const fieldConfidenceSchema = z
  .object({
    vendor: nullableConfidenceSchema,
    transactionDate: nullableConfidenceSchema,
    totalCents: nullableConfidenceSchema,
    taxCents: nullableConfidenceSchema,
    paymentLastFour: nullableConfidenceSchema,
    suggestedCategoryId: nullableConfidenceSchema,
    lineItems: nullableConfidenceSchema,
  })
  .strict();

const EXTRACTION_CONFIDENCE_FIELDS = [
  "vendor",
  "transactionDate",
  "totalCents",
  "taxCents",
  "paymentLastFour",
  "suggestedCategoryId",
  "lineItems",
] as const;

/**
 * Strict model-output contract for receipt extraction.
 *
 * Every property is required by design. Unknown values are represented as null,
 * never omitted, defaulted, or inferred. That makes missing evidence distinct
 * from malformed model output and is compatible with strict structured output.
 */
export const ExpenseReceiptExtractionSchema = z
  .object({
    vendor: z.string().trim().min(1).max(240).nullable(),
    transactionDate: nullableDateOnlySchema,
    totalCents: z.number().int().min(1).max(MAX_RECEIPT_MONEY_CENTS).nullable(),
    taxCents: z.number().int().min(0).max(MAX_RECEIPT_MONEY_CENTS).nullable(),
    paymentLastFour: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable(),
    suggestedCategoryId: nullableCategoryIdSchema,
    lineItems: z
      .array(ExpenseReceiptLineItemSchema)
      .min(1)
      .max(MAX_LINE_ITEMS)
      .nullable(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(MAX_WARNINGS),
    fieldConfidence: fieldConfidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const field of EXTRACTION_CONFIDENCE_FIELDS) {
      const hasValue = value[field] !== null;
      const hasConfidence = value.fieldConfidence[field] !== null;
      if (hasValue === hasConfidence) continue;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldConfidence", field],
        message: hasValue
          ? "A populated extraction field requires a confidence score."
          : "A missing extraction field must use null confidence.",
      });
    }

    if (
      value.taxCents !== null &&
      value.totalCents !== null &&
      value.taxCents > value.totalCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taxCents"],
        message: "Receipt tax cannot exceed the receipt total.",
      });
    }
  });

export type ExpenseReceiptExtraction = z.infer<
  typeof ExpenseReceiptExtractionSchema
>;
export type ExpenseReceiptExtractionField =
  (typeof EXTRACTION_CONFIDENCE_FIELDS)[number];

export type ExpenseReceiptExtractionValidationResult =
  | {
      ok: true;
      extraction: ExpenseReceiptExtraction;
    }
  | {
      ok: false;
      issues: Array<{
        field: string;
        code: string;
        message: string;
      }>;
    };

export function validateExpenseReceiptExtraction(
  input: unknown,
): ExpenseReceiptExtractionValidationResult {
  const parsed = ExpenseReceiptExtractionSchema.safeParse(input);
  if (parsed.success) return { ok: true, extraction: parsed.data };

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "payload",
      code: issue.code,
      message: issue.message,
    })),
  };
}

export type ExpenseReceiptReviewField<T> = {
  value: T | null;
  confidence: number | null;
  status: "ready" | "check_this";
  attentionLabel: "Check this" | null;
  reason: "missing" | "low_confidence" | null;
};

export type ExpenseReceiptReview = {
  fields: {
    vendor: ExpenseReceiptReviewField<string>;
    transactionDate: ExpenseReceiptReviewField<string>;
    totalCents: ExpenseReceiptReviewField<number>;
    taxCents: ExpenseReceiptReviewField<number>;
    paymentLastFour: ExpenseReceiptReviewField<string>;
    suggestedCategoryId: ExpenseReceiptReviewField<string>;
    lineItems: ExpenseReceiptReviewField<ExpenseReceiptLineItem[]>;
  };
  fieldsToCheck: ExpenseReceiptExtractionField[];
  warnings: string[];
  requiresHumanConfirmation: true;
};

function reviewField<T>(input: {
  value: T | null;
  confidence: number | null;
  threshold: number;
  required: boolean;
  blankWhenUncertain: boolean;
}): ExpenseReceiptReviewField<T> {
  const missing = input.value === null;
  const lowConfidence =
    !missing &&
    (input.confidence === null || input.confidence < input.threshold);
  const needsAttention = (input.required && missing) || lowConfidence;
  const reason = missing
    ? input.required
      ? "missing"
      : null
    : lowConfidence
      ? "low_confidence"
      : null;

  return {
    value: needsAttention && input.blankWhenUncertain ? null : input.value,
    confidence: input.confidence,
    status: needsAttention ? "check_this" : "ready",
    attentionLabel: needsAttention ? "Check this" : null,
    reason,
  };
}

/**
 * Produces a UI-safe prefill. Date and total are never prefilled when their
 * confidence is below the threshold, and no missing value receives a default.
 */
export function buildExpenseReceiptReview(
  extraction: ExpenseReceiptExtraction,
  confidenceThreshold = DEFAULT_RECEIPT_CONFIDENCE_THRESHOLD,
): ExpenseReceiptReview {
  if (
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  ) {
    throw new RangeError("confidenceThreshold must be between 0 and 1.");
  }

  const fields: ExpenseReceiptReview["fields"] = {
    vendor: reviewField({
      value: extraction.vendor,
      confidence: extraction.fieldConfidence.vendor,
      threshold: confidenceThreshold,
      required: true,
      blankWhenUncertain: false,
    }),
    transactionDate: reviewField({
      value: extraction.transactionDate,
      confidence: extraction.fieldConfidence.transactionDate,
      threshold: confidenceThreshold,
      required: true,
      blankWhenUncertain: true,
    }),
    totalCents: reviewField({
      value: extraction.totalCents,
      confidence: extraction.fieldConfidence.totalCents,
      threshold: confidenceThreshold,
      required: true,
      blankWhenUncertain: true,
    }),
    taxCents: reviewField({
      value: extraction.taxCents,
      confidence: extraction.fieldConfidence.taxCents,
      threshold: confidenceThreshold,
      required: false,
      blankWhenUncertain: false,
    }),
    paymentLastFour: reviewField({
      value: extraction.paymentLastFour,
      confidence: extraction.fieldConfidence.paymentLastFour,
      threshold: confidenceThreshold,
      required: false,
      blankWhenUncertain: false,
    }),
    suggestedCategoryId: reviewField({
      value: extraction.suggestedCategoryId,
      confidence: extraction.fieldConfidence.suggestedCategoryId,
      threshold: confidenceThreshold,
      required: true,
      blankWhenUncertain: false,
    }),
    lineItems: reviewField({
      value: extraction.lineItems,
      confidence: extraction.fieldConfidence.lineItems,
      threshold: confidenceThreshold,
      required: false,
      blankWhenUncertain: false,
    }),
  };

  return {
    fields,
    fieldsToCheck: EXTRACTION_CONFIDENCE_FIELDS.filter(
      (field) => fields[field].status === "check_this",
    ),
    warnings: [...extraction.warnings],
    requiresHumanConfirmation: true,
  };
}

export function normalizeReceiptVendor(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return normalized || null;
}

const duplicateReceiptSchema = z
  .object({
    sha256: z
      .string()
      .trim()
      .regex(SHA_256_PATTERN)
      .transform((value) => value.toLowerCase()),
    vendor: z.string().trim().min(1).max(240).nullable(),
    totalCents: z.number().int().min(1).max(MAX_RECEIPT_MONEY_CENTS).nullable(),
    transactionDate: nullableDateOnlySchema,
  })
  .strict();

const duplicateCandidateSchema = duplicateReceiptSchema
  .omit({ sha256: true })
  .extend({
    id: z.string().trim().min(1).max(160),
    sha256: z
      .string()
      .trim()
      .regex(SHA_256_PATTERN)
      .transform((value) => value.toLowerCase())
      .nullable(),
  })
  .strict();

const duplicateDetectionSchema = z
  .object({
    receipt: duplicateReceiptSchema,
    candidates: z.array(duplicateCandidateSchema).max(10_000),
    maxNearbyDays: z.number().int().min(0).max(31),
  })
  .strict();

export type ReceiptDuplicateCandidate = z.input<
  typeof duplicateCandidateSchema
>;
export type ReceiptDuplicateInput = z.input<typeof duplicateReceiptSchema>;

export type ReceiptDuplicateDetection = {
  highestRisk: "exact" | "fuzzy" | null;
  exactMatches: Array<{
    candidateId: string;
    kind: "exact";
  }>;
  fuzzyMatches: Array<{
    candidateId: string;
    kind: "fuzzy";
    normalizedVendor: string;
    daysApart: number;
  }>;
};

function dateOnlyDayNumber(value: string): number {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw new RangeError("Expected a validated YYYY-MM-DD calendar date.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
}

/**
 * Exact hash matches take priority. Fuzzy candidates require all three stable
 * comparison fields: normalized vendor, exact cents, and a nearby date.
 */
export function detectExpenseReceiptDuplicates(
  receipt: ReceiptDuplicateInput,
  candidates: ReceiptDuplicateCandidate[],
  options: { maxNearbyDays?: number } = {},
): ReceiptDuplicateDetection {
  const parsed = duplicateDetectionSchema.parse({
    receipt,
    candidates,
    maxNearbyDays: options.maxNearbyDays ?? DEFAULT_FUZZY_DUPLICATE_WINDOW_DAYS,
  });

  const exactCandidateIds = new Set(
    parsed.candidates
      .filter((candidate) => candidate.sha256 === parsed.receipt.sha256)
      .map((candidate) => candidate.id),
  );
  const exactMatches = [...exactCandidateIds]
    .sort((left, right) => left.localeCompare(right))
    .map((candidateId) => ({
      candidateId,
      kind: "exact" as const,
    }));

  const normalizedVendor = normalizeReceiptVendor(parsed.receipt.vendor);
  const receiptDay = parsed.receipt.transactionDate
    ? dateOnlyDayNumber(parsed.receipt.transactionDate)
    : null;
  const fuzzyMatches =
    normalizedVendor !== null &&
    parsed.receipt.totalCents !== null &&
    receiptDay !== null
      ? parsed.candidates
          .filter((candidate) => !exactCandidateIds.has(candidate.id))
          .flatMap((candidate) => {
            if (
              candidate.totalCents !== parsed.receipt.totalCents ||
              candidate.transactionDate === null ||
              normalizeReceiptVendor(candidate.vendor) !== normalizedVendor
            ) {
              return [];
            }
            const daysApart = Math.abs(
              receiptDay - dateOnlyDayNumber(candidate.transactionDate),
            );
            return daysApart <= parsed.maxNearbyDays
              ? [
                  {
                    candidateId: candidate.id,
                    kind: "fuzzy" as const,
                    normalizedVendor,
                    daysApart,
                  },
                ]
              : [];
          })
          .sort((left, right) =>
            left.daysApart === right.daysApart
              ? left.candidateId.localeCompare(right.candidateId)
              : left.daysApart - right.daysApart,
          )
      : [];

  return {
    highestRisk:
      exactMatches.length > 0
        ? "exact"
        : fuzzyMatches.length > 0
          ? "fuzzy"
          : null,
    exactMatches,
    fuzzyMatches,
  };
}

export const ExactDuplicateOverrideSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const vendorCategoryRuleSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(160),
    vendor: z.string().trim().min(1).max(240),
    categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN),
    ownerLocked: z.boolean(),
    categoryConfirmationCount: z.number().int().min(0).max(1_000_000),
    vendorConfirmationCount: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.categoryConfirmationCount > value.vendorConfirmationCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryConfirmationCount"],
        message:
          "Category confirmations cannot exceed total vendor confirmations.",
      });
    }
  });

const categorySelectionSchema = z
  .object({
    vendor: z.string().trim().min(1).max(240).nullable(),
    rules: z.array(vendorCategoryRuleSchema).max(10_000),
    aiSuggestedCategoryId: nullableCategoryIdSchema,
  })
  .strict();

export type VendorCategoryRule = z.input<typeof vendorCategoryRuleSchema>;
export type ExpenseCategorySelection = {
  categoryId: string | null;
  source: "owner_locked" | "learned" | "ai" | "none";
  ruleId: string | null;
  confirmationCount: number | null;
  agreement: number | null;
};

function ruleAgreement(rule: z.infer<typeof vendorCategoryRuleSchema>): number {
  if (rule.vendorConfirmationCount === 0) return 0;
  return rule.categoryConfirmationCount / rule.vendorConfirmationCount;
}

function compareLearnedRules(
  left: z.infer<typeof vendorCategoryRuleSchema>,
  right: z.infer<typeof vendorCategoryRuleSchema>,
): number {
  const agreementDifference = ruleAgreement(right) - ruleAgreement(left);
  if (agreementDifference !== 0) return agreementDifference;
  const countDifference =
    right.categoryConfirmationCount - left.categoryConfirmationCount;
  if (countDifference !== 0) return countDifference;
  return left.ruleId.localeCompare(right.ruleId);
}

/** Applies owner intent first, sufficiently-confirmed learning second, and AI last. */
export function selectExpenseCategory(input: {
  vendor: string | null;
  rules: VendorCategoryRule[];
  aiSuggestedCategoryId: string | null;
}): ExpenseCategorySelection {
  const parsed = categorySelectionSchema.parse(input);
  const normalizedVendor = normalizeReceiptVendor(parsed.vendor);
  const matchingRules = normalizedVendor
    ? parsed.rules.filter(
        (rule) => normalizeReceiptVendor(rule.vendor) === normalizedVendor,
      )
    : [];

  const ownerRule = matchingRules
    .filter((rule) => rule.ownerLocked)
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId))[0];
  if (ownerRule) {
    return {
      categoryId: ownerRule.categoryId,
      source: "owner_locked",
      ruleId: ownerRule.ruleId,
      confirmationCount: ownerRule.categoryConfirmationCount,
      agreement: ruleAgreement(ownerRule),
    };
  }

  const learnedRule = matchingRules
    .filter(
      (rule) =>
        !rule.ownerLocked &&
        rule.categoryConfirmationCount >= 3 &&
        ruleAgreement(rule) >= 0.8,
    )
    .sort(compareLearnedRules)[0];
  if (learnedRule) {
    return {
      categoryId: learnedRule.categoryId,
      source: "learned",
      ruleId: learnedRule.ruleId,
      confirmationCount: learnedRule.categoryConfirmationCount,
      agreement: ruleAgreement(learnedRule),
    };
  }

  return parsed.aiSuggestedCategoryId
    ? {
        categoryId: parsed.aiSuggestedCategoryId,
        source: "ai",
        ruleId: null,
        confirmationCount: null,
        agreement: null,
      }
    : {
        categoryId: null,
        source: "none",
        ruleId: null,
        confirmationCount: null,
        agreement: null,
      };
}

export const ExpenseAllocationSetSchema = z
  .object({
    totalCents: z.number().int().min(1).max(MAX_RECEIPT_MONEY_CENTS),
    allocations: z
      .array(
        z
          .object({
            categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN),
            amountCents: z.number().int().min(1).max(MAX_RECEIPT_MONEY_CENTS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ALLOCATIONS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenCategories = new Set<string>();
    for (const [index, allocation] of value.allocations.entries()) {
      if (seenCategories.has(allocation.categoryId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allocations", index, "categoryId"],
          message: "Combine duplicate category allocations into one row.",
        });
      }
      seenCategories.add(allocation.categoryId);
    }

    const allocatedCents = value.allocations.reduce(
      (sum, allocation) => sum + allocation.amountCents,
      0,
    );
    if (allocatedCents !== value.totalCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allocations"],
        message: `Allocations must total exactly ${value.totalCents} cents; received ${allocatedCents} cents.`,
      });
    }
  });

export type ExpenseAllocationSet = z.infer<typeof ExpenseAllocationSetSchema>;

export type ExpenseAllocationValidationResult =
  | { ok: true; allocationSet: ExpenseAllocationSet }
  | {
      ok: false;
      issues: Array<{ field: string; code: string; message: string }>;
    };

export function validateExpenseAllocations(
  input: unknown,
): ExpenseAllocationValidationResult {
  const parsed = ExpenseAllocationSetSchema.safeParse(input);
  if (parsed.success) return { ok: true, allocationSet: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "payload",
      code: issue.code,
      message: issue.message,
    })),
  };
}
