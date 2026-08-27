import { createHash } from "node:crypto";
import { z } from "zod";
import {
  detectExpenseReceiptUploadContentType,
  type ExpenseReceiptContentType,
} from "@/lib/expense-receipt-storage";
import { TeamMutationFailure } from "@/lib/team-mutation";

export const MAX_EXPENSE_CENTS = 100_000_000;
export const MAX_EXPENSE_RECEIPT_BYTES = 10 * 1024 * 1024;
const EARLIEST_EXPENSE_DATE = new Date("2000-01-01T00:00:00.000Z");
const LATEST_COVERAGE_DATE = new Date("2100-01-01T00:00:00.000Z");
const ALLOWED_METHODS = [
  "card",
  "cash",
  "ach",
  "check",
  "zelle",
  "other",
] as const;
const MANUAL_SOURCES = new Set(["manual", "manual_correction", "receipt_scan"]);

const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .nullable()
    .optional()
    .transform((value) => value || null);

export const ExpenseWriteSchema = z
  .object({
    amountCents: z.number().int().min(1).max(MAX_EXPENSE_CENTS),
    currency: z.literal("USD").default("USD"),
    category: z.string().trim().min(1).max(120),
    vendor: optionalText(240),
    memo: optionalText(2_000),
    method: z.enum(ALLOWED_METHODS).nullable().optional().default(null),
    paidAt: z.string().datetime({ offset: true }),
    coverageStartAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
    coverageEndAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const ExpenseCorrectionSchema = ExpenseWriteSchema.extend({
  reason: z.string().trim().min(3).max(500),
}).strict();

export const ExpenseReasonSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export type ExpenseWriteInput = z.infer<typeof ExpenseWriteSchema>;
export type ExpenseCorrectionInput = z.infer<typeof ExpenseCorrectionSchema>;

export type ValidatedExpenseWrite = Omit<
  ExpenseWriteInput,
  "paidAt" | "coverageStartAt" | "coverageEndAt"
> & {
  paidAt: Date;
  coverageStartAt: Date | null;
  coverageEndAt: Date | null;
};

export type ExpenseReceipt = {
  filename: string;
  contentType: ExpenseReceiptContentType;
  bytes: Buffer;
  sha256: string;
  byteLength: number;
};

export type ParsedExpenseRequest = {
  expense: ValidatedExpenseWrite;
  receipt: ExpenseReceipt | null;
  reason: string | null;
};

export type ExpenseLifecycleRecord = {
  lifecycleStatus: "draft" | "posted" | "voided" | "corrected";
  source: string;
  bankTransactionId: string | null;
  payoutRunId: string | null;
  reversalOfExpenseId: string | null;
};

export type ExpenseFinancialShape = {
  amount: number;
  currency: string;
  coverageStartAt: Date | null;
  coverageEndAt: Date | null;
};

function fieldErrors(error: z.ZodError): Record<string, string> {
  const flattened = error.flatten().fieldErrors as Record<
    string,
    string[] | undefined
  >;
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flattened)) {
    result[field] = messages?.[0] ?? "Invalid value";
  }
  return result;
}

function invalidPayload(error: z.ZodError): never {
  throw new TeamMutationFailure(
    "invalid",
    "Review the highlighted expense fields and try again.",
    { fieldErrors: fieldErrors(error) },
  );
}

function assertDateRange(name: string, value: Date, latest: Date): void {
  if (
    Number.isNaN(value.getTime()) ||
    value.getTime() < EARLIEST_EXPENSE_DATE.getTime() ||
    value.getTime() > latest.getTime()
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the expense dates and try again.",
      {
        fieldErrors: {
          [name]: "Use a valid date in the supported accounting period.",
        },
      },
    );
  }
}

export function validateExpenseWriteInput(
  input: unknown,
  now = new Date(),
): ValidatedExpenseWrite {
  const parsed = ExpenseWriteSchema.safeParse(input);
  if (!parsed.success) invalidPayload(parsed.error);

  const paidAt = new Date(parsed.data.paidAt);
  const coverageStartAt = parsed.data.coverageStartAt
    ? new Date(parsed.data.coverageStartAt)
    : null;
  const coverageEndAt = parsed.data.coverageEndAt
    ? new Date(parsed.data.coverageEndAt)
    : null;
  const latestPaidAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  assertDateRange("paidAt", paidAt, latestPaidAt);
  if (coverageStartAt) {
    assertDateRange("coverageStartAt", coverageStartAt, LATEST_COVERAGE_DATE);
  }
  if (coverageEndAt) {
    assertDateRange("coverageEndAt", coverageEndAt, LATEST_COVERAGE_DATE);
  }
  if (
    coverageStartAt &&
    coverageEndAt &&
    coverageEndAt.getTime() < coverageStartAt.getTime()
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Coverage end must be on or after coverage start.",
      {
        fieldErrors: {
          coverageEndAt: "Choose a date on or after coverage start.",
        },
      },
    );
  }

  return {
    ...parsed.data,
    paidAt,
    coverageStartAt,
    coverageEndAt,
  };
}

function sanitizedFilename(value: string): string {
  const basename = value.normalize("NFKC").split(/[\\/]/u).pop() ?? "receipt";
  const safe = [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  return (safe || "receipt").slice(0, 240);
}

export function detectExpenseReceiptContentType(
  bytes: Uint8Array,
): ExpenseReceipt["contentType"] | null {
  return detectExpenseReceiptUploadContentType(Buffer.from(bytes));
}

export async function parseExpenseReceiptFile(
  value: FormDataEntryValue | null,
): Promise<ExpenseReceipt | null> {
  if (value === null) return null;
  if (!(value instanceof File)) {
    throw new TeamMutationFailure(
      "invalid",
      "The receipt upload is malformed.",
      { fieldErrors: { receiptFile: "Choose a valid receipt file." } },
    );
  }
  if (value.size === 0) return null;
  if (value.size > MAX_EXPENSE_RECEIPT_BYTES) {
    throw new TeamMutationFailure(
      "invalid",
      "The receipt is larger than 10 MB.",
      { fieldErrors: { receiptFile: "Choose a file no larger than 10 MB." } },
    );
  }

  const bytes = Buffer.from(await value.arrayBuffer());
  const contentType = detectExpenseReceiptContentType(bytes);
  if (!contentType) {
    throw new TeamMutationFailure(
      "invalid",
      "The receipt file type could not be verified.",
      {
        fieldErrors: {
          receiptFile: "Use a JPEG, PNG, WebP, HEIC, or PDF receipt.",
        },
      },
    );
  }

  return {
    filename: sanitizedFilename(value.name || "receipt"),
    contentType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numericFormValue(form: FormData, key: string): number {
  const value = formString(form, key);
  return value !== null && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
}

export async function parseExpenseRequest(
  request: Request,
  options: { requireReason?: boolean; allowReceipt?: boolean } = {},
): Promise<ParsedExpenseRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  let rawExpense: unknown;
  let rawReason: unknown = null;
  let receipt: ExpenseReceipt | null = null;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new TeamMutationFailure(
        "invalid",
        "The expense form could not be read.",
      );
    }
    rawExpense = {
      amountCents: numericFormValue(form, "amountCents"),
      currency: formString(form, "currency") ?? "USD",
      category: formString(form, "category") ?? "",
      vendor: formString(form, "vendor"),
      memo: formString(form, "memo"),
      method: formString(form, "method"),
      paidAt: formString(form, "paidAt") ?? "",
      coverageStartAt: formString(form, "coverageStartAt"),
      coverageEndAt: formString(form, "coverageEndAt"),
    };
    rawReason = formString(form, "reason");
    if (options.allowReceipt !== false) {
      receipt = await parseExpenseReceiptFile(form.get("receiptFile"));
    } else if (form.get("receiptFile") instanceof File) {
      const file = form.get("receiptFile") as File;
      if (file.size > 0) {
        throw new TeamMutationFailure(
          "invalid",
          "A corrected expense keeps its original receipt as immutable evidence.",
          {
            fieldErrors: {
              receiptFile: "Add supporting evidence to the original record.",
            },
          },
        );
      }
    }
  } else {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("invalid_json_shape");
      }
      if (options.requireReason) {
        const { reason, ...expense } = body;
        rawExpense = expense;
        rawReason = reason;
      } else {
        rawExpense = body;
      }
    } catch {
      throw new TeamMutationFailure(
        "invalid",
        "The expense request must contain valid JSON.",
      );
    }
  }

  const expense = validateExpenseWriteInput(rawExpense);
  let reason: string | null = null;
  if (options.requireReason) {
    const parsedReason = ExpenseReasonSchema.safeParse({ reason: rawReason });
    if (!parsedReason.success) invalidPayload(parsedReason.error);
    reason = parsedReason.data.reason;
  }
  return { expense, receipt, reason };
}

export async function parseExpenseReasonRequest(
  request: Request,
): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  let rawReason: unknown = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    rawReason = formString(form, "reason");
  } else {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      rawReason = body?.["reason"];
    } catch {
      throw new TeamMutationFailure("invalid", "A valid reason is required.");
    }
  }
  const parsed = ExpenseReasonSchema.safeParse({ reason: rawReason });
  if (!parsed.success) invalidPayload(parsed.error);
  return parsed.data.reason;
}

export function assertExpenseActionAllowed(
  expense: ExpenseLifecycleRecord,
  action: "edit" | "post" | "correct" | "void",
): void {
  if (
    expense.bankTransactionId ||
    expense.payoutRunId ||
    !MANUAL_SOURCES.has(expense.source)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This expense is managed by a provider or payout workflow and cannot be changed here.",
    );
  }
  if (expense.reversalOfExpenseId) {
    throw new TeamMutationFailure(
      "conflict",
      "A generated reversal is immutable.",
    );
  }
  if (
    (action === "edit" || action === "post") &&
    expense.lifecycleStatus !== "draft"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      action === "edit"
        ? "Only draft expenses can be edited."
        : "Only draft expenses can be posted.",
    );
  }
  if (
    (action === "correct" || action === "void") &&
    expense.lifecycleStatus !== "posted"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      action === "correct"
        ? "Only a current posted expense can be corrected."
        : "Only a current posted expense can be voided.",
    );
  }
}

export function assertExpenseFinancialShape(
  expense: ExpenseFinancialShape,
): void {
  if (
    !Number.isSafeInteger(expense.amount) ||
    expense.amount <= 0 ||
    expense.currency !== "USD" ||
    (expense.coverageStartAt !== null &&
      Number.isNaN(expense.coverageStartAt.getTime())) ||
    (expense.coverageEndAt !== null &&
      Number.isNaN(expense.coverageEndAt.getTime())) ||
    (expense.coverageStartAt !== null &&
      expense.coverageEndAt !== null &&
      expense.coverageEndAt.getTime() < expense.coverageStartAt.getTime())
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This historical expense has a financial anomaly and needs finance review before it can change.",
    );
  }
}

export function expenseIdempotencyPayload(
  parsed: ParsedExpenseRequest,
): Record<string, unknown> {
  return {
    ...parsed.expense,
    paidAt: parsed.expense.paidAt.toISOString(),
    coverageStartAt: parsed.expense.coverageStartAt?.toISOString() ?? null,
    coverageEndAt: parsed.expense.coverageEndAt?.toISOString() ?? null,
    reason: parsed.reason,
    receipt: parsed.receipt
      ? {
          sha256: parsed.receipt.sha256,
          byteLength: parsed.receipt.byteLength,
          contentType: parsed.receipt.contentType,
          filename: parsed.receipt.filename,
        }
      : null,
  };
}
