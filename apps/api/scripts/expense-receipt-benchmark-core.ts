import { z } from "zod";

export const EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION = 2 as const;
export const EXPENSE_RECEIPT_BENCHMARK_MINIMUM_COUNT = 100;
export const EXPENSE_RECEIPT_BENCHMARK_MAXIMUM_COUNT = 500;
export const EXPENSE_RECEIPT_BENCHMARK_TOTAL_THRESHOLD_BPS = 9_800;
export const EXPENSE_RECEIPT_BENCHMARK_DATE_THRESHOLD_BPS = 9_500;
export const EXPENSE_RECEIPT_BENCHMARK_VENDOR_THRESHOLD_BPS = 9_500;
export const EXPENSE_RECEIPT_BENCHMARK_DOCUMENT_TYPE_THRESHOLD_BPS = 9_500;
export const EXPENSE_RECEIPT_BENCHMARK_NET_WEIGHT_THRESHOLD_BPS = 9_800;
export const EXPENSE_RECEIPT_BENCHMARK_NON_SCALE_WEIGHT_NULL_THRESHOLD_BPS = 10_000;
export const EXPENSE_RECEIPT_BENCHMARK_MINIMUM_LAYOUT_COUNT = 20;
export const EXPENSE_RECEIPT_BENCHMARK_MINIMUM_WEIGHTED_SCALE_TICKET_COUNT = 20;
export const EXPENSE_RECEIPT_BENCHMARK_MINIMUM_STANDARD_RECEIPT_COUNT = 20;

const MAX_RECEIPT_MONEY_CENTS = 100_000_000;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const RECEIPT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/u;
const MODEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9])?$/u;

export const EXPENSE_RECEIPT_BENCHMARK_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export type ExpenseReceiptBenchmarkContentType =
  (typeof EXPENSE_RECEIPT_BENCHMARK_CONTENT_TYPES)[number];

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

function isSafeRelativeFile(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    value.length < 1 ||
    value.length > 500 ||
    value.includes("\\") ||
    hasControlCharacter ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}

const exactNonblankString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), {
      message: "Leading or trailing whitespace is not allowed.",
    });

const receiptSchema = z
  .object({
    id: z.string().regex(RECEIPT_ID_PATTERN),
    file: z.string().refine(isSafeRelativeFile, {
      message: "Use a safe path relative to the manifest directory.",
    }),
    contentType: z.enum(EXPENSE_RECEIPT_BENCHMARK_CONTENT_TYPES),
    layout: z.enum(["portrait", "landscape"]),
    documentType: z.enum(["standard_receipt", "scale_ticket"]),
    expected: z
      .object({
        totalCents: z.number().int().min(1).max(MAX_RECEIPT_MONEY_CENTS),
        transactionDate: exactNonblankString(10).refine(isCalendarDate, {
          message: "Use a real calendar date in YYYY-MM-DD form.",
        }),
        vendor: exactNonblankString(240),
        netWeightPounds: z.number().int().min(1).max(10_000_000).nullable(),
      })
      .strict(),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION),
    representativeCorpusReviewed: z.literal(true),
    groundTruthReviewed: z.literal(true),
    receipts: z
      .array(receiptSchema)
      .min(EXPENSE_RECEIPT_BENCHMARK_MINIMUM_COUNT)
      .max(EXPENSE_RECEIPT_BENCHMARK_MAXIMUM_COUNT),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const files = new Set<string>();
    value.receipts.forEach((receipt, index) => {
      if (ids.has(receipt.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipts", index, "id"],
          message: "Receipt IDs must be unique.",
        });
      }
      ids.add(receipt.id);
      if (files.has(receipt.file)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipts", index, "file"],
          message: "Receipt files must be unique.",
        });
      }
      files.add(receipt.file);
      if (
        receipt.documentType === "standard_receipt" &&
        receipt.expected.netWeightPounds !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipts", index, "expected", "netWeightPounds"],
          message: "Standard receipts cannot have scale-ticket weight truth.",
        });
      }
    });
    for (const layout of ["portrait", "landscape"] as const) {
      if (
        value.receipts.filter((receipt) => receipt.layout === layout).length <
        EXPENSE_RECEIPT_BENCHMARK_MINIMUM_LAYOUT_COUNT
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipts"],
          message: `Include at least ${EXPENSE_RECEIPT_BENCHMARK_MINIMUM_LAYOUT_COUNT} ${layout} receipts.`,
        });
      }
    }
    if (
      value.receipts.filter(
        (receipt) =>
          receipt.documentType === "scale_ticket" &&
          receipt.expected.netWeightPounds !== null,
      ).length < EXPENSE_RECEIPT_BENCHMARK_MINIMUM_WEIGHTED_SCALE_TICKET_COUNT
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipts"],
        message: `Include at least ${EXPENSE_RECEIPT_BENCHMARK_MINIMUM_WEIGHTED_SCALE_TICKET_COUNT} scale tickets with reviewed net weights.`,
      });
    }
    if (
      value.receipts.filter(
        (receipt) => receipt.documentType === "standard_receipt",
      ).length < EXPENSE_RECEIPT_BENCHMARK_MINIMUM_STANDARD_RECEIPT_COUNT
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipts"],
        message: `Include at least ${EXPENSE_RECEIPT_BENCHMARK_MINIMUM_STANDARD_RECEIPT_COUNT} standard receipts as false-weight negative controls.`,
      });
    }
  });

export type ExpenseReceiptBenchmarkManifest = z.infer<typeof manifestSchema>;

export class ExpenseReceiptBenchmarkError extends Error {
  constructor(
    readonly code: string,
    readonly field: string | null = null,
  ) {
    super(code);
    this.name = "ExpenseReceiptBenchmarkError";
  }
}

function firstIssueField(error: z.ZodError): string | null {
  const issue = error.issues[0];
  return issue ? issue.path.join(".") || "manifest" : null;
}

export function parseExpenseReceiptBenchmarkManifest(
  input: unknown,
): ExpenseReceiptBenchmarkManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_manifest_invalid",
      firstIssueField(parsed.error),
    );
  }
  return parsed.data;
}

export type ExpenseReceiptBenchmarkCliOptions = {
  manifestPath: string;
  executeLive: boolean;
  confirmation: string | null;
  model: string | null;
};

function exactArgumentValue(
  args: readonly string[],
  name: string,
): string | null {
  const prefix = `${name}=`;
  const matches = args.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) {
    throw new ExpenseReceiptBenchmarkError("benchmark_argument_duplicate");
  }
  return matches[0]?.slice(prefix.length) ?? null;
}

export function parseExpenseReceiptBenchmarkArgs(
  args: readonly string[],
): ExpenseReceiptBenchmarkCliOptions {
  for (const argument of args) {
    if (
      argument !== "--execute-live" &&
      !argument.startsWith("--manifest=") &&
      !argument.startsWith("--confirm-live=") &&
      !argument.startsWith("--model=")
    ) {
      throw new ExpenseReceiptBenchmarkError("benchmark_argument_unknown");
    }
  }
  if (args.filter((argument) => argument === "--execute-live").length > 1) {
    throw new ExpenseReceiptBenchmarkError("benchmark_argument_duplicate");
  }

  const manifestPath = exactArgumentValue(args, "--manifest");
  const confirmation = exactArgumentValue(args, "--confirm-live");
  const model = exactArgumentValue(args, "--model");
  const executeLive = args.includes("--execute-live");

  if (!manifestPath?.trim()) {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_manifest_argument_required",
    );
  }
  if (manifestPath.includes("\u0000")) {
    throw new ExpenseReceiptBenchmarkError("benchmark_manifest_path_invalid");
  }
  if (!executeLive && (confirmation !== null || model !== null)) {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_live_arguments_without_execute",
    );
  }
  if (model !== null && !MODEL_PATTERN.test(model)) {
    throw new ExpenseReceiptBenchmarkError("benchmark_model_invalid");
  }

  return {
    manifestPath,
    executeLive,
    confirmation,
    model,
  };
}

export function expenseReceiptBenchmarkConfirmation(
  receiptCount: number,
): string {
  if (
    !Number.isSafeInteger(receiptCount) ||
    receiptCount < EXPENSE_RECEIPT_BENCHMARK_MINIMUM_COUNT ||
    receiptCount > EXPENSE_RECEIPT_BENCHMARK_MAXIMUM_COUNT
  ) {
    throw new ExpenseReceiptBenchmarkError("benchmark_receipt_count_invalid");
  }
  return `RUN_PRIVATE_RECEIPT_BENCHMARK_${receiptCount}`;
}

export function assertExpenseReceiptBenchmarkLiveAuthorized(input: {
  receiptCount: number;
  confirmation: string | null;
  model: string | null;
}): { model: string } {
  if (!input.model) {
    throw new ExpenseReceiptBenchmarkError("benchmark_live_model_required");
  }
  if (
    input.confirmation !==
    expenseReceiptBenchmarkConfirmation(input.receiptCount)
  ) {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_live_confirmation_required",
    );
  }
  return { model: input.model };
}

export type ExpenseReceiptBenchmarkExtraction = {
  totalCents: number | null;
  transactionDate: string | null;
  vendor: string | null;
  documentType: "standard_receipt" | "scale_ticket" | "unknown";
  netWeightPounds: number | null;
};

export type ExpenseReceiptBenchmarkResult = {
  id: string;
  extraction: ExpenseReceiptBenchmarkExtraction | null;
};

export type ExpenseReceiptBenchmarkMetric = {
  exactCount: number;
  evaluatedCount: number;
  accuracyPercent: number;
  thresholdPercent: number;
  passed: boolean;
};

export type ExpenseReceiptBenchmarkScore = {
  passed: boolean;
  receiptCount: number;
  analyzedCount: number;
  providerFailureCount: number;
  metrics: {
    total: ExpenseReceiptBenchmarkMetric;
    transactionDate: ExpenseReceiptBenchmarkMetric;
    vendor: ExpenseReceiptBenchmarkMetric;
    documentType: ExpenseReceiptBenchmarkMetric;
    netWeightPounds: ExpenseReceiptBenchmarkMetric;
    nonScaleWeightNull: ExpenseReceiptBenchmarkMetric;
  };
};

function percentage(exactCount: number, evaluatedCount: number): number {
  return Math.round((exactCount / evaluatedCount) * 10_000) / 100;
}

function metric(
  exactCount: number,
  evaluatedCount: number,
  thresholdBasisPoints: number,
): ExpenseReceiptBenchmarkMetric {
  return {
    exactCount,
    evaluatedCount,
    accuracyPercent: percentage(exactCount, evaluatedCount),
    thresholdPercent: thresholdBasisPoints / 100,
    passed: exactCount * 10_000 >= evaluatedCount * thresholdBasisPoints,
  };
}

export function scoreExpenseReceiptBenchmark(
  manifest: ExpenseReceiptBenchmarkManifest,
  results: readonly ExpenseReceiptBenchmarkResult[],
): ExpenseReceiptBenchmarkScore {
  if (results.length !== manifest.receipts.length) {
    throw new ExpenseReceiptBenchmarkError("benchmark_result_count_mismatch");
  }
  const resultById = new Map<
    string,
    ExpenseReceiptBenchmarkExtraction | null
  >();
  for (const result of results) {
    if (resultById.has(result.id)) {
      throw new ExpenseReceiptBenchmarkError("benchmark_result_id_duplicate");
    }
    resultById.set(result.id, result.extraction);
  }

  let totalExact = 0;
  let dateExact = 0;
  let vendorExact = 0;
  let documentTypeExact = 0;
  let netWeightExact = 0;
  let nonScaleWeightNullExact = 0;
  const scaleTicketCount = manifest.receipts.filter(
    (receipt) => receipt.documentType === "scale_ticket",
  ).length;
  const standardReceiptCount = manifest.receipts.length - scaleTicketCount;
  let analyzedCount = 0;
  for (const receipt of manifest.receipts) {
    if (!resultById.has(receipt.id)) {
      throw new ExpenseReceiptBenchmarkError("benchmark_result_id_missing");
    }
    const extraction = resultById.get(receipt.id) ?? null;
    if (!extraction) continue;
    analyzedCount += 1;
    if (extraction.totalCents === receipt.expected.totalCents) totalExact += 1;
    if (extraction.transactionDate === receipt.expected.transactionDate) {
      dateExact += 1;
    }
    if (extraction.vendor === receipt.expected.vendor) vendorExact += 1;
    if (extraction.documentType === receipt.documentType) {
      documentTypeExact += 1;
    }
    if (receipt.documentType === "scale_ticket") {
      if (extraction.netWeightPounds === receipt.expected.netWeightPounds) {
        netWeightExact += 1;
      }
    } else if (extraction.netWeightPounds === null) {
      nonScaleWeightNullExact += 1;
    }
  }

  const evaluatedCount = manifest.receipts.length;
  const metrics = {
    total: metric(
      totalExact,
      evaluatedCount,
      EXPENSE_RECEIPT_BENCHMARK_TOTAL_THRESHOLD_BPS,
    ),
    transactionDate: metric(
      dateExact,
      evaluatedCount,
      EXPENSE_RECEIPT_BENCHMARK_DATE_THRESHOLD_BPS,
    ),
    vendor: metric(
      vendorExact,
      evaluatedCount,
      EXPENSE_RECEIPT_BENCHMARK_VENDOR_THRESHOLD_BPS,
    ),
    documentType: metric(
      documentTypeExact,
      evaluatedCount,
      EXPENSE_RECEIPT_BENCHMARK_DOCUMENT_TYPE_THRESHOLD_BPS,
    ),
    netWeightPounds: metric(
      netWeightExact,
      scaleTicketCount,
      EXPENSE_RECEIPT_BENCHMARK_NET_WEIGHT_THRESHOLD_BPS,
    ),
    nonScaleWeightNull: metric(
      nonScaleWeightNullExact,
      standardReceiptCount,
      EXPENSE_RECEIPT_BENCHMARK_NON_SCALE_WEIGHT_NULL_THRESHOLD_BPS,
    ),
  };

  return {
    passed:
      metrics.total.passed &&
      metrics.transactionDate.passed &&
      metrics.vendor.passed &&
      metrics.documentType.passed &&
      metrics.netWeightPounds.passed &&
      metrics.nonScaleWeightNull.passed,
    receiptCount: evaluatedCount,
    analyzedCount,
    providerFailureCount: evaluatedCount - analyzedCount,
    metrics,
  };
}

export type ExpenseReceiptBenchmarkValidationReport = {
  ok: true;
  mode: "validation";
  schemaVersion: typeof EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION;
  receiptCount: number;
  thresholds: {
    totalExactPercent: 98;
    transactionDateExactPercent: 95;
    vendorExactPercent: 95;
    documentTypeExactPercent: 95;
    scaleTicketNetWeightExactPercent: 98;
    nonScaleWeightNullExactPercent: 100;
  };
  liveRun: {
    apiRequestsMade: false;
    explicitConfirmationRequired: true;
    confirmation: string;
    explicitModelRequired: true;
  };
};

export function expenseReceiptBenchmarkValidationReport(
  manifest: ExpenseReceiptBenchmarkManifest,
): ExpenseReceiptBenchmarkValidationReport {
  return {
    ok: true,
    mode: "validation",
    schemaVersion: EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION,
    receiptCount: manifest.receipts.length,
    thresholds: {
      totalExactPercent: 98,
      transactionDateExactPercent: 95,
      vendorExactPercent: 95,
      documentTypeExactPercent: 95,
      scaleTicketNetWeightExactPercent: 98,
      nonScaleWeightNullExactPercent: 100,
    },
    liveRun: {
      apiRequestsMade: false,
      explicitConfirmationRequired: true,
      confirmation: expenseReceiptBenchmarkConfirmation(
        manifest.receipts.length,
      ),
      explicitModelRequired: true,
    },
  };
}

export type ExpenseReceiptBenchmarkLiveReport = {
  ok: boolean;
  mode: "live";
  schemaVersion: typeof EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION;
  model: string;
  score: ExpenseReceiptBenchmarkScore;
};

export function expenseReceiptBenchmarkLiveReport(input: {
  model: string;
  score: ExpenseReceiptBenchmarkScore;
}): ExpenseReceiptBenchmarkLiveReport {
  return {
    ok: input.score.passed,
    mode: "live",
    schemaVersion: EXPENSE_RECEIPT_BENCHMARK_SCHEMA_VERSION,
    model: input.model,
    score: input.score,
  };
}

export function expenseReceiptBenchmarkFailureReport(
  error: unknown,
  mode: "validation" | "live",
): {
  ok: false;
  mode: "validation" | "live";
  error: string;
  field?: string;
} {
  if (error instanceof ExpenseReceiptBenchmarkError) {
    return {
      ok: false,
      mode,
      error: error.code,
      ...(error.field ? { field: error.field } : {}),
    };
  }
  return { ok: false, mode, error: "benchmark_failed" };
}
