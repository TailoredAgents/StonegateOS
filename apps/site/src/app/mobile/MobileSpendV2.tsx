"use client";

import * as React from "react";
import {
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Megaphone,
  PencilLine,
  ReceiptText,
  RotateCcw,
  X,
} from "lucide-react";
import {
  MOBILE_EXPENSE_QUEUE_EVENT,
  createExpenseCaptureDraft,
  listExpenseCaptureQueue,
  queueExpenseCapture,
  refreshExpenseCapture,
  removeExpenseCapture,
  shouldPollExpenseCaptureStatus,
  syncEmployeeExpenseCaptures,
  syncExpenseCapture,
  type ExpenseCaptureQueueRow,
} from "./lib/expense-capture-queue";
import {
  acknowledgeExpenseMutationAttempt,
  getExpenseMutationAttempt,
} from "./lib/expense-mutation-idempotency";
import {
  addDateKeyDays,
  centsToMoneyInput,
  easternDateKey,
  expenseAllocationTotal,
  expenseErrorMessage,
  formatExpenseMoney,
  formatExpensePercent,
  mondayForDateKey,
  moneyInputToCents,
} from "./spend-v2-utils";
import { MobileExpenseDonut } from "./MobileExpenseDonut";
import {
  MobileFixedCosts,
  parseMobileFixedCostsPayload,
  type MobileFixedCost,
} from "./MobileFixedCosts";

type SpendView = "add" | "overview" | "history";
type AddWorkflow = "scan" | "manual" | "ads" | null;

type ExpenseCategory = { id: string; name: string; sortOrder?: number };
type MemberOption = { id: string; name: string };
type JobOption = { id: string; label: string; date: string };

export type ExpenseDumpDetails = {
  weightStatus: "confirmed" | "unreadable";
  facilityName: string | null;
  ticketNumber: string | null;
  material: string | null;
  grossWeightPounds: number | null;
  tareWeightPounds: number | null;
  netWeightPounds: number | null;
  billedWeightMilliTons: number | null;
  unitRateCentsPerTon: number | null;
};

export type ExpenseDumpDetailsDraft = {
  weightStatus: "confirmed" | "unreadable";
  facilityName: string;
  ticketNumber: string;
  material: string;
  grossWeightPounds: string;
  tareWeightPounds: string;
  netWeightPounds: string;
  billedWeightTons: string;
  unitRateDollarsPerTon: string;
};

type ExpenseDumpSubmissionDetails = ExpenseDumpDetails & { reviewed: true };

type ExpenseHistoryDumpDetails = ExpenseDumpDetails & {
  confirmedBy: MemberOption | null;
  confirmedAt: string | null;
  createdAt: string | null;
};

type ExpenseCapabilities = {
  manualEntry: boolean;
  receiptCapture: boolean;
  reimbursement: boolean;
  dailyAdSpend: boolean;
  overview: boolean;
  exactDuplicateReview: boolean;
  fixedCosts: boolean;
  dumpTickets: boolean;
};

type ExpenseHistoryRow = {
  id: string;
  amountCents: number;
  currency: string;
  categoryId: string | null;
  category: string;
  categoryNeedsReview: boolean;
  allocations: Array<{
    categoryId: string;
    category: string;
    amountCents: number;
  }>;
  vendor: string | null;
  notes: string | null;
  method: string | null;
  source: string;
  purchaseDate: string;
  paidAt?: string | null;
  coverageStartAt?: string | null;
  coverageEndAt?: string | null;
  payerType: "company" | "personal";
  paidByMember: MemberOption | null;
  submitter: MemberOption | null;
  reviewStatus: "draft" | "pending" | "approved" | "rejected" | null;
  reviewer: MemberOption | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  lifecycleStatus: string;
  version: number;
  appointmentId: string | null;
  coveredByFixedCostSeriesId: string | null;
  coveredByFixedCostName: string | null;
  dumpDetails: ExpenseHistoryDumpDetails | null;
  reversalOfExpenseId: string | null;
  correctionOfExpenseId: string | null;
  correctedByExpenseId: string | null;
  receipt: {
    captureId: string | null;
    status: string | null;
    filename: string | null;
  } | null;
  reimbursement: { claimId: string | null; status: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

type ExpenseCaptureStatus = Record<string, unknown> & {
  id: string;
  status: string;
  version: number;
  filename: string;
  contentPath: string | null;
};

type ExactDuplicateReviewItem = {
  capture: ExpenseCaptureStatus;
  submitter: MemberOption;
  duplicate: {
    capture: {
      id: string;
      status: string;
      filename: string;
      submittedBy: string;
      submitterName: string;
      contentPath: string | null;
    };
    expense: {
      id: string;
      amountCents: number;
      currency: string;
      categoryId: string | null;
      category: string | null;
      vendor: string | null;
      paidAt: string;
      lifecycleStatus: string;
      reviewStatus: string;
    } | null;
  } | null;
};

type ExpenseOverviewIncompleteReason =
  | "missing_ad_entries"
  | "missing_commission_data"
  | "missing_final_totals"
  | "pending_expenses"
  | "unverified_historical_records"
  | "unverified_expense_categories";

type OverviewCompleteness = {
  state: "complete" | "incomplete";
  reasons: ExpenseOverviewIncompleteReason[];
};

type OverviewPeriod = {
  week?: never;
  startDate: string;
  endDate: string;
  revenueCents: number;
  ordinaryExpensesCents: number;
  laborCents: number;
  fixedCostsCents: number;
  fixedCosts: {
    amountCents: number;
    activeSeriesCount: number;
    coveredExpenseCount: number;
    coveredExpenseAmountCents: number;
  };
  totalExpensesCents: number;
  operatingProfitCents: number;
  expenseRatioPercent: number | null;
  pendingExpenseCount: number;
  missingAdEntries: Array<{
    businessDate: string;
    missingPlatforms: Array<"facebook" | "google">;
  }>;
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
  omittedUnverifiedHistoricalRecordCount: number;
  unverifiedExpenseCategoryCount: number;
  completeness: OverviewCompleteness;
  dumpActivity: ExpenseDumpActivity;
};

type ExpenseDumpActivity = {
  dumpFeeCents: number;
  ticketCount: number;
  weightedTicketCount: number;
  netWeightPounds: number;
  averageCostPerTonCents: number | null;
  missingWeightCount: number;
};

type DailyAdEntry = {
  amountCents: number;
  version: number;
  expenseId: string | null;
  confirmedAt: string;
};

type DailyAdDay = {
  businessDate: string;
  facebook: DailyAdEntry | null;
  google: DailyAdEntry | null;
};

function dailyAdEntry(value: unknown): DailyAdEntry | null {
  const record = objectValue(value);
  return record &&
    typeof record["amountCents"] === "number" &&
    Number.isSafeInteger(record["amountCents"]) &&
    typeof record["version"] === "number" &&
    Number.isSafeInteger(record["version"])
    ? {
        amountCents: record["amountCents"],
        version: record["version"],
        expenseId:
          typeof record["expenseId"] === "string" ? record["expenseId"] : null,
        confirmedAt:
          typeof record["confirmedAt"] === "string"
            ? record["confirmedAt"]
            : "",
      }
    : null;
}

type OverviewPayload = {
  week: { startDate: string; endDate: string };
  revenueCents: number;
  ordinaryExpensesCents: number;
  laborCents: number;
  fixedCostsCents: number;
  fixedCosts: {
    amountCents: number;
    activeSeriesCount: number;
    coveredExpenseCount: number;
    coveredExpenseAmountCents: number;
  };
  totalExpensesCents: number;
  operatingProfitCents: number;
  expenseRatioPercent: number | null;
  priorWeek: OverviewPeriod;
  priorWeekChange: {
    available: boolean;
    states: {
      revenue: "available" | "zero_baseline" | "incomplete";
      expenses: "available" | "zero_baseline" | "incomplete";
      operatingProfit: "available" | "zero_baseline" | "incomplete";
      expenseRatio: "available" | "undefined_ratio" | "incomplete";
    };
    revenueCents: number | null;
    revenuePercent: number | null;
    expensesCents: number | null;
    expensesPercent: number | null;
    operatingProfitCents: number | null;
    operatingProfitPercent: number | null;
    expenseRatioPercentagePoints: number | null;
    unavailableReasons: {
      currentWeek: ExpenseOverviewIncompleteReason[];
      priorWeek: ExpenseOverviewIncompleteReason[];
    };
  };
  categories: Array<{
    id: string;
    label: string;
    amountCents: number;
    percentOfExpenses: number | null;
    percentOfRevenue: number | null;
    verified: boolean;
  }>;
  labor: {
    state: "actual" | "estimated";
    amountCents: number;
    subrows: {
      crewCents: number;
      salesCents: number;
      managementCents: number;
      otherPayrollAdjustmentsCents: number;
    };
  };
  advertising: {
    amountCents: number;
    subrows: { facebookCents: number; googleCents: number };
    unattributedCents: number;
  };
  dumpActivity: ExpenseDumpActivity;
  pendingExpenseCount: number;
  missingAdEntries: Array<{
    businessDate: string;
    missingPlatforms: Array<"facebook" | "google">;
  }>;
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
  omittedUnverifiedHistoricalRecordCount: number;
  unverifiedExpenseCategoryCount: number;
  completeness: OverviewCompleteness;
};

type SubmissionBody = {
  amountCents: number;
  purchaseDate: string;
  categoryId: string;
  allocations?: Array<{ categoryId: string; amountCents: number }>;
  coveredByFixedCostSeriesId?: string | null;
  vendor: string | null;
  notes: string | null;
  method: "card" | "cash" | "ach" | "check" | "zelle" | "other" | null;
  payerType: "company" | "personal";
  paidByMemberId: string | null;
  appointmentId: string | null;
  dumpDetails?: ExpenseDumpSubmissionDetails;
};

type ScaleTicketDisposition = "not_scale_ticket" | null;

type ExpenseDumpCorrectionBody = {
  amountCents: number;
  currency: "USD";
  category: string;
  vendor: string | null;
  memo: string | null;
  method: SubmissionBody["method"];
  paidAt: string;
  coverageStartAt: string | null;
  coverageEndAt: string | null;
  reason: string;
  dumpDetails: ExpenseDumpSubmissionDetails | null;
};

type ExpenseDumpCorrectionRow = Pick<
  ExpenseHistoryRow,
  | "id"
  | "amountCents"
  | "currency"
  | "category"
  | "categoryNeedsReview"
  | "vendor"
  | "notes"
  | "method"
  | "source"
  | "lifecycleStatus"
  | "version"
  | "allocations"
  | "paidAt"
  | "coverageStartAt"
  | "coverageEndAt"
>;

type ExpenseMutationAttempt = Awaited<
  ReturnType<typeof getExpenseMutationAttempt>
>;

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";
const controlClass = `${focusRing} min-h-11 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2.5 text-base text-white`;
const primaryButton = `${focusRing} min-h-11 w-full rounded-lg bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50`;
const secondaryButton = `${focusRing} min-h-11 rounded-lg border border-white/15 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50`;
const cardClass = "rounded-xl border border-white/10 bg-white/[0.07] p-4";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

const expenseWeightFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const expenseTonsFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});
const expenseConfirmationFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});
const expenseCaptureIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const expenseRecordIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const expensePaymentMethods = new Set([
  "card",
  "cash",
  "ach",
  "check",
  "zelle",
  "other",
]);

function nullableExpenseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableExpenseInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function expenseCaptureEvidenceHref(capture: unknown): string | null {
  const record = objectValue(capture);
  const captureId = record?.["id"];
  const contentPath = record?.["contentPath"];
  return typeof contentPath === "string" &&
    contentPath.trim().length > 0 &&
    typeof captureId === "string" &&
    expenseCaptureIdPattern.test(captureId)
    ? `/api/mobile/expenses/captures/${encodeURIComponent(captureId)}/content`
    : null;
}

export function expenseConfirmationDuplicateKind(
  status: number,
  payloadValue: unknown,
  context: {
    attemptedDumpDetails?: boolean;
    knownExactReceipt?: boolean;
  } = {},
): "scale_ticket" | "exact_receipt" | null {
  const payload = objectValue(payloadValue);
  const fieldErrors = objectValue(payload?.["fieldErrors"]);
  const overrideError = fieldErrors?.["exactDuplicateOverrideReason"];
  const message = [payload?.["message"], overrideError]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const duplicateResponse =
    typeof overrideError === "string" ||
    (status === 409 && /duplicate|already exist/iu.test(message));
  if (!duplicateResponse) return null;
  if (context.knownExactReceipt) return "exact_receipt";
  return (
    context.attemptedDumpDetails === true ||
    /facility|ticket number|scale[- ]ticket/iu.test(message)
  )
    ? "scale_ticket"
    : "exact_receipt";
}

function emptyExpenseDumpDetailsDraft(): ExpenseDumpDetailsDraft {
  return {
    weightStatus: "confirmed",
    facilityName: "",
    ticketNumber: "",
    material: "",
    grossWeightPounds: "",
    tareWeightPounds: "",
    netWeightPounds: "",
    billedWeightTons: "",
    unitRateDollarsPerTon: "",
  };
}

function expenseDumpDetailsDraft(
  details: Partial<ExpenseDumpDetails> | null | undefined,
): ExpenseDumpDetailsDraft {
  const billedWeightMilliTons = details?.billedWeightMilliTons ?? null;
  return {
    ...emptyExpenseDumpDetailsDraft(),
    weightStatus: details?.weightStatus ?? "confirmed",
    facilityName: details?.facilityName ?? "",
    ticketNumber: details?.ticketNumber ?? "",
    material: details?.material ?? "",
    grossWeightPounds:
      typeof details?.grossWeightPounds === "number"
        ? String(details.grossWeightPounds)
        : "",
    tareWeightPounds:
      typeof details?.tareWeightPounds === "number"
        ? String(details.tareWeightPounds)
        : "",
    netWeightPounds:
      typeof details?.netWeightPounds === "number"
        ? String(details.netWeightPounds)
        : "",
    billedWeightTons:
      typeof billedWeightMilliTons === "number"
        ? (billedWeightMilliTons / 1_000)
            .toFixed(3)
            .replace(/0+$/u, "")
            .replace(/\.$/u, "")
        : "",
    unitRateDollarsPerTon:
      typeof details?.unitRateCentsPerTon === "number"
        ? centsToMoneyInput(details.unitRateCentsPerTon)
        : "",
  };
}

export function parseExpenseDumpPoundsInput(
  value: string,
  options: { allowZero?: boolean } = {},
): number | null {
  const normalized = value.replace(/[\s,]/gu, "");
  if (!/^[0-9]{1,8}$/u.test(normalized)) return null;
  const pounds = Number(normalized);
  return Number.isSafeInteger(pounds) &&
    pounds <= 10_000_000 &&
    (pounds > 0 || (options.allowZero === true && pounds === 0))
    ? pounds
    : null;
}

export function parseExpenseDumpMilliTonsInput(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  const match = /^(\d{1,5})(?:\.(\d{1,3}))?$/u.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(3, "0"));
  const milliTons = whole * 1_000 + fraction;
  return milliTons >= 0 && milliTons <= 10_000_000 ? milliTons : null;
}

export function formatExpenseDumpWeight(pounds: number): string {
  if (!Number.isSafeInteger(pounds) || pounds <= 0) return "Weight unreadable";
  const tons = pounds / 2_000;
  return `${expenseWeightFormatter.format(pounds)} lb · ${expenseTonsFormatter.format(tons)} ${tons === 1 ? "ton" : "tons"}`;
}

function formatExpenseDumpTons(milliTons: number): string {
  const tons = milliTons / 1_000;
  return `${expenseTonsFormatter.format(tons)} ${tons === 1 ? "ton" : "tons"}`;
}

function formatExpenseDumpConfirmation(
  value: string | null | undefined,
): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : expenseConfirmationFormatter.format(parsed);
}

function expenseDumpDraftHasData(draft: ExpenseDumpDetailsDraft): boolean {
  return [
    draft.facilityName,
    draft.ticketNumber,
    draft.material,
    draft.grossWeightPounds,
    draft.tareWeightPounds,
    draft.netWeightPounds,
    draft.billedWeightTons,
    draft.unitRateDollarsPerTon,
  ].some((value) => value.trim().length > 0);
}

export function buildExpenseDumpSubmissionDetails(
  draft: ExpenseDumpDetailsDraft,
  options: { required: boolean },
):
  | { ok: true; details: ExpenseDumpSubmissionDetails | null }
  | { ok: false; message: string } {
  const hasData = expenseDumpDraftHasData(draft);
  if (!options.required && !hasData && draft.weightStatus === "confirmed") {
    return { ok: true, details: null };
  }

  const parsePounds = (
    value: string,
    label: string,
    allowZero = false,
  ): number | null | string => {
    if (!value.trim()) return null;
    return (
      parseExpenseDumpPoundsInput(value, { allowZero }) ??
      `${label} must be a whole number of pounds.`
    );
  };
  const grossWeightPounds = parsePounds(
    draft.grossWeightPounds,
    "Gross weight",
  );
  if (typeof grossWeightPounds === "string") {
    return { ok: false, message: grossWeightPounds };
  }
  const tareWeightPounds = parsePounds(
    draft.tareWeightPounds,
    "Tare weight",
    true,
  );
  if (typeof tareWeightPounds === "string") {
    return { ok: false, message: tareWeightPounds };
  }
  const netWeightPounds =
    draft.weightStatus === "unreadable"
      ? null
      : parsePounds(draft.netWeightPounds, "Net weight");
  if (typeof netWeightPounds === "string") {
    return { ok: false, message: netWeightPounds };
  }
  const billedWeightMilliTons = draft.billedWeightTons.trim()
    ? parseExpenseDumpMilliTonsInput(draft.billedWeightTons)
    : null;
  if (draft.billedWeightTons.trim() && billedWeightMilliTons === null) {
    return {
      ok: false,
      message:
        "Billed weight must be a valid ton value with up to three decimals.",
    };
  }
  const unitRateCentsPerTon = draft.unitRateDollarsPerTon.trim()
    ? moneyInputToCents(draft.unitRateDollarsPerTon)
    : null;
  if (
    draft.unitRateDollarsPerTon.trim() &&
    (unitRateCentsPerTon === null ||
      unitRateCentsPerTon < 0 ||
      unitRateCentsPerTon > 100_000_000)
  ) {
    return {
      ok: false,
      message: "Unit rate must be a valid dollar amount per ton.",
    };
  }
  if (
    grossWeightPounds !== null &&
    tareWeightPounds !== null &&
    grossWeightPounds < tareWeightPounds
  ) {
    return {
      ok: false,
      message: "Gross weight cannot be less than tare weight.",
    };
  }
  if (draft.weightStatus === "unreadable") {
    return {
      ok: true,
      details: {
        weightStatus: "unreadable",
        facilityName: nullableExpenseString(draft.facilityName),
        ticketNumber: nullableExpenseString(draft.ticketNumber),
        material: nullableExpenseString(draft.material),
        grossWeightPounds,
        tareWeightPounds,
        netWeightPounds: null,
        billedWeightMilliTons,
        unitRateCentsPerTon,
        reviewed: true,
      },
    };
  }
  if (netWeightPounds === null) {
    return {
      ok: false,
      message:
        options.required || hasData
          ? "Enter the net weight, or mark the scale-ticket weight unreadable."
          : "Enter the net weight printed on the scale ticket.",
    };
  }
  return {
    ok: true,
    details: {
      weightStatus: "confirmed",
      facilityName: nullableExpenseString(draft.facilityName),
      ticketNumber: nullableExpenseString(draft.ticketNumber),
      material: nullableExpenseString(draft.material),
      grossWeightPounds,
      tareWeightPounds,
      netWeightPounds,
      billedWeightMilliTons,
      unitRateCentsPerTon,
      reviewed: true,
    },
  };
}

function exactExpenseIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function expenseHistoryCanCorrectDumpWeight(
  row: ExpenseDumpCorrectionRow,
  canApprove: boolean,
): boolean {
  const validCoverage = (value: unknown): boolean =>
    value === null || exactExpenseIsoInstant(value);
  return (
    canApprove &&
    expenseRecordIdPattern.test(row.id) &&
    row.lifecycleStatus === "posted" &&
    ["manual", "receipt_scan", "manual_correction"].includes(row.source) &&
    row.currency === "USD" &&
    Number.isSafeInteger(row.amountCents) &&
    row.amountCents > 0 &&
    row.category.trim().length > 0 &&
    row.category.trim().length <= 120 &&
    !row.categoryNeedsReview &&
    (row.method === null || expensePaymentMethods.has(row.method)) &&
    Number.isSafeInteger(row.version) &&
    row.version >= 1 &&
    row.allocations.some(
      (allocation) =>
        allocation.categoryId === "dump_fees" && allocation.amountCents > 0,
    ) &&
    exactExpenseIsoInstant(row.paidAt) &&
    validCoverage(row.coverageStartAt) &&
    validCoverage(row.coverageEndAt)
  );
}

export function buildExpenseDumpCorrectionBody(
  row: ExpenseDumpCorrectionRow,
  draft: ExpenseDumpDetailsDraft,
  reasonValue: string,
  removeDumpDetails = false,
):
  | { ok: true; body: ExpenseDumpCorrectionBody }
  | { ok: false; message: string } {
  if (!expenseHistoryCanCorrectDumpWeight(row, true) || !row.paidAt) {
    return {
      ok: false,
      message: "Refresh History before correcting this dump weight.",
    };
  }
  const reason = reasonValue.trim();
  if (reason.length < 3 || reason.length > 500) {
    return {
      ok: false,
      message: "Explain the weight correction in 3 to 500 characters.",
    };
  }
  const parsedDumpDetails = removeDumpDetails
    ? ({ ok: true, details: null } as const)
    : buildExpenseDumpSubmissionDetails(draft, { required: true });
  if (!parsedDumpDetails.ok) return parsedDumpDetails;
  if (!removeDumpDetails && !parsedDumpDetails.details) {
    return {
      ok: false,
      message: "Review the dump-ticket weight before saving the correction.",
    };
  }
  return {
    ok: true,
    body: {
      amountCents: row.amountCents,
      currency: "USD",
      category: row.category,
      vendor: row.vendor,
      memo: row.notes,
      method: row.method as SubmissionBody["method"],
      paidAt: row.paidAt,
      coverageStartAt: row.coverageStartAt ?? null,
      coverageEndAt: row.coverageEndAt ?? null,
      reason,
      dumpDetails: parsedDumpDetails.details,
    },
  };
}

const emptyExpenseDumpActivity: ExpenseDumpActivity = {
  dumpFeeCents: 0,
  ticketCount: 0,
  weightedTicketCount: 0,
  netWeightPounds: 0,
  averageCostPerTonCents: null,
  missingWeightCount: 0,
};

export function expenseDumpActivityValue(value: unknown): ExpenseDumpActivity {
  const activity = objectValue(value);
  const nonnegative = (name: string): number => {
    const candidate = activity?.[name];
    return typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : 0;
  };
  const average = activity?.["averageCostPerTonCents"];
  return {
    ...emptyExpenseDumpActivity,
    dumpFeeCents: nonnegative("dumpFeeCents"),
    ticketCount: nonnegative("ticketCount"),
    weightedTicketCount: nonnegative("weightedTicketCount"),
    netWeightPounds: nonnegative("netWeightPounds"),
    averageCostPerTonCents:
      typeof average === "number" &&
      Number.isSafeInteger(average) &&
      average >= 0
        ? average
        : null,
    missingWeightCount: nonnegative("missingWeightCount"),
  };
}

export function expenseHistoryDumpDetailsValue(
  value: unknown,
): ExpenseHistoryDumpDetails | null {
  const details = objectValue(value);
  if (!details) return null;
  const netWeightPounds = nullableExpenseInteger(details["netWeightPounds"]);
  const rawStatus = details["weightStatus"];
  const rawConfirmedBy = objectValue(details["confirmedBy"]);
  const weightStatus =
    rawStatus === "confirmed" || rawStatus === "unreadable"
      ? rawStatus
      : netWeightPounds && netWeightPounds > 0
        ? "confirmed"
        : "unreadable";
  return {
    weightStatus,
    facilityName: nullableExpenseString(details["facilityName"]),
    ticketNumber: nullableExpenseString(details["ticketNumber"]),
    material: nullableExpenseString(details["material"]),
    grossWeightPounds: nullableExpenseInteger(details["grossWeightPounds"]),
    tareWeightPounds: nullableExpenseInteger(details["tareWeightPounds"]),
    netWeightPounds,
    billedWeightMilliTons: nullableExpenseInteger(
      details["billedWeightMilliTons"],
    ),
    unitRateCentsPerTon: nullableExpenseInteger(details["unitRateCentsPerTon"]),
    confirmedBy:
      typeof rawConfirmedBy?.["id"] === "string" &&
      typeof rawConfirmedBy["name"] === "string"
        ? { id: rawConfirmedBy["id"], name: rawConfirmedBy["name"] }
        : null,
    confirmedAt: nullableExpenseString(details["confirmedAt"]),
    createdAt: nullableExpenseString(details["createdAt"]),
  };
}

export function expenseHistoryDisplayStatus(
  lifecycleStatus: string,
  reviewStatus: ExpenseHistoryRow["reviewStatus"],
): string {
  return lifecycleStatus === "corrected" || lifecycleStatus === "voided"
    ? lifecycleStatus
    : (reviewStatus ?? lifecycleStatus);
}

export function expenseHistoryCorrectionLabel(
  row: Pick<
    ExpenseHistoryRow,
    "reversalOfExpenseId" | "correctionOfExpenseId" | "correctedByExpenseId"
  >,
): string | null {
  if (row.reversalOfExpenseId) {
    return "Correction reversal — offsets original";
  }
  if (row.correctedByExpenseId) {
    return "Original expense — replaced";
  }
  if (row.correctionOfExpenseId) {
    return "Active corrected entry";
  }
  return null;
}

function expenseOverviewWithDumpDefaults(
  value: Record<string, unknown>,
): OverviewPayload {
  const priorWeek = objectValue(value["priorWeek"]);
  return {
    ...(value as unknown as OverviewPayload),
    dumpActivity: expenseDumpActivityValue(value["dumpActivity"]),
    priorWeek: {
      ...(priorWeek as unknown as OverviewPeriod),
      dumpActivity: expenseDumpActivityValue(priorWeek?.["dumpActivity"]),
    },
  };
}

async function jsonPayload(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return objectValue(await response.json().catch(() => null));
}

function useFixedCostCoverageOptions(
  enabled: boolean,
  businessDate: string,
): {
  costs: MobileFixedCost[];
  loading: boolean;
  error: string | null;
} {
  const [costs, setCosts] = React.useState<MobileFixedCost[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
      setCosts([]);
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(
      `/api/mobile/expenses/fixed-costs?asOf=${encodeURIComponent(businessDate)}`,
      { cache: "no-store", credentials: "include" },
    )
      .then(async (response) => ({
        response,
        payload: await jsonPayload(response),
      }))
      .then(({ response, payload }) => {
        if (!response.ok) {
          throw new Error(
            expenseErrorMessage(payload, "Fixed-cost matching is unavailable."),
          );
        }
        const parsed = parseMobileFixedCostsPayload(payload);
        if (!parsed) throw new Error("The fixed-cost response was invalid.");
        if (active) {
          setCosts(parsed.costs.filter((cost) => cost.state === "active"));
        }
      })
      .catch((reasonValue: unknown) => {
        if (!active) return;
        setCosts([]);
        setError(
          reasonValue instanceof Error
            ? reasonValue.message
            : "Fixed-cost matching is unavailable.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [businessDate, enabled]);

  return { costs, loading, error };
}

function FixedCostCoverageField({
  enabled,
  purchaseDate,
  amountCents,
  categoryId,
  splitEnabled,
  value,
  onChange,
}: {
  enabled: boolean;
  purchaseDate: string;
  amountCents: number | null;
  categoryId: string;
  splitEnabled: boolean;
  value: string;
  onChange: (seriesId: string) => void;
}) {
  const { costs, loading, error } = useFixedCostCoverageOptions(
    enabled,
    purchaseDate,
  );
  const selected = costs.find((cost) => cost.seriesId === value) ?? null;
  const mismatch =
    selected &&
    (selected.monthlyAmountCents !== amountCents ||
      selected.categoryId !== categoryId);

  React.useEffect(() => {
    if (value && !loading && !costs.some((cost) => cost.seriesId === value)) {
      onChange("");
    }
  }, [costs, loading, onChange, value]);

  if (!enabled) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
      <label className="block">
        <FieldLabel>Already included as a fixed cost?</FieldLabel>
        <select
          value={value}
          disabled={loading || splitEnabled || Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass}
        >
          <option value="">
            {loading ? "Loading fixed costs…" : "No — count this separately"}
          </option>
          {costs.map((cost) => (
            <option key={cost.seriesId} value={cost.seriesId}>
              {cost.name} · {formatExpenseMoney(cost.monthlyAmountCents)}/month
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        Choose a schedule only for that same monthly bill. The receipt stays in
        History, while Overview uses the daily fixed-cost accrual once.
      </p>
      {splitEnabled ? (
        <p className="mt-1 text-xs text-amber-200">
          Fixed-cost coverage requires one category.
        </p>
      ) : error ? (
        <p className="mt-1 text-xs text-rose-200">{error}</p>
      ) : mismatch && selected ? (
        <p className="mt-1 text-xs text-amber-200">
          This schedule is {formatExpenseMoney(selected.monthlyAmountCents)} in
          {` ${selected.category}`}. Match both the amount and category before
          submitting.
        </p>
      ) : value ? (
        <p className="mt-1 text-xs font-semibold text-emerald-200">
          This payment will not be counted a second time in Overview.
        </p>
      ) : null}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs font-semibold text-slate-300">
      {children}
    </span>
  );
}

function AttentionBadge() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] font-bold text-amber-100">
      <CircleAlert aria-hidden="true" className="size-3" />
      Check this
    </span>
  );
}

function StatusNotice({
  message,
  tone = "info",
}: {
  message: string;
  tone?: "info" | "error" | "success";
}) {
  const classes =
    tone === "error"
      ? "border-rose-300/30 bg-rose-300/10 text-rose-100"
      : tone === "success"
        ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
        : "border-cyan-300/25 bg-cyan-300/10 text-cyan-100";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      className={`rounded-lg border p-3 text-sm leading-6 ${classes}`}
    >
      {message}
    </div>
  );
}

function SegmentedControl({
  value,
  onChange,
  showOverview,
}: {
  value: SpendView;
  onChange: (view: SpendView) => void;
  showOverview: boolean;
}) {
  const views: SpendView[] = showOverview
    ? ["add", "overview", "history"]
    : ["add", "history"];
  return (
    <div
      aria-label="Spend views"
      className={`grid ${showOverview ? "grid-cols-3" : "grid-cols-2"} rounded-xl border border-white/10 bg-slate-900 p-1`}
      role="group"
    >
      {views.map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          onClick={() => onChange(view)}
          className={`${focusRing} min-h-11 rounded-lg px-2 text-sm font-semibold transition ${
            value === view ? "bg-white/15 text-white" : "text-slate-300"
          }`}
        >
          {view.charAt(0).toUpperCase() + view.slice(1)}
        </button>
      ))}
    </div>
  );
}

export type ExpenseAddChoicePresentation = {
  id: Exclude<AddWorkflow, null>;
  label: string;
  detail: string;
  primary: boolean;
  disabled: boolean;
};

/** Keep the Add surface stable while capabilities fail closed. */
export function expenseAddChoices(input: {
  canSubmit: boolean;
  receiptEnabled: boolean;
  adSpendEnabled: boolean;
  pendingCapture: boolean;
  missingYesterday: boolean;
}): ExpenseAddChoicePresentation[] {
  const scanAvailable = input.canSubmit && input.receiptEnabled;
  const adSpendAvailable = input.adSpendEnabled;
  const primaryChoice = scanAvailable
    ? "scan"
    : adSpendAvailable
      ? "ads"
      : "manual";

  return [
    {
      id: "scan",
      label: "Scan receipt",
      detail: !scanAvailable
        ? "Unavailable right now"
        : input.pendingCapture
          ? "Continue a receipt waiting on this device"
          : "Camera or photo upload",
      primary: primaryChoice === "scan",
      disabled: !scanAvailable,
    },
    {
      id: "ads",
      label: "Daily ad spend",
      detail: !adSpendAvailable
        ? "Owner access or setup required"
        : input.missingYesterday
          ? "Yesterday needs an entry"
          : "Facebook and Google",
      primary: primaryChoice === "ads",
      disabled: !adSpendAvailable,
    },
    {
      id: "manual",
      label: "Manual entry",
      detail: input.canSubmit
        ? "Enter an expense without a receipt"
        : "Expense submission unavailable",
      primary: primaryChoice === "manual",
      disabled: !input.canSubmit,
    },
  ];
}

function AddChoices({
  canSubmit,
  receiptEnabled,
  adSpendEnabled,
  pendingCapture,
  missingYesterday,
  onChoose,
}: {
  canSubmit: boolean;
  receiptEnabled: boolean;
  adSpendEnabled: boolean;
  pendingCapture: ExpenseCaptureQueueRow | null;
  missingYesterday: boolean;
  onChoose: (workflow: Exclude<AddWorkflow, null>) => void;
}) {
  const choices = expenseAddChoices({
    canSubmit,
    receiptEnabled,
    adSpendEnabled,
    pendingCapture: pendingCapture !== null,
    missingYesterday,
  });
  const choiceIcons = {
    scan: Camera,
    ads: Megaphone,
    manual: PencilLine,
  } satisfies Record<ExpenseAddChoicePresentation["id"], typeof Camera>;
  return (
    <div className="space-y-3">
      {choices.map((choice) => {
        const Icon = choiceIcons[choice.id];
        return (
          <button
            key={choice.id}
            type="button"
            disabled={choice.disabled}
            onClick={() => onChoose(choice.id)}
            className={`${focusRing} flex min-h-[68px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
              choice.primary
                ? "border-cyan-300 bg-cyan-300 text-slate-950"
                : "border-white/15 bg-white/[0.07] text-white"
            }`}
          >
            <Icon aria-hidden="true" className="size-6 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-bold">{choice.label}</span>
              <span
                className={`mt-0.5 block text-xs ${choice.primary ? "text-slate-700" : "text-slate-400"}`}
              >
                {choice.detail}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type SplitRow = { key: string; categoryId: string; amount: string };

function dumpAttentionField(attentionFields: string[], field: string): boolean {
  return attentionFields.some(
    (candidate) =>
      candidate === "dumpTicket" ||
      candidate === "dumpDetails" ||
      candidate === field ||
      candidate === `dumpTicket.${field}` ||
      candidate === `dumpDetails.${field}`,
  );
}

function DumpTicketFields({
  draft,
  onChange,
  required,
  attentionFields,
}: {
  draft: ExpenseDumpDetailsDraft;
  onChange: (draft: ExpenseDumpDetailsDraft) => void;
  required: boolean;
  attentionFields: string[];
}) {
  const netHelpId = React.useId();
  const unreadable = draft.weightStatus === "unreadable";
  const netWeight = parseExpenseDumpPoundsInput(draft.netWeightPounds);
  const grossWeight = parseExpenseDumpPoundsInput(draft.grossWeightPounds);
  const tareWeight = parseExpenseDumpPoundsInput(draft.tareWeightPounds, {
    allowZero: true,
  });
  const measuredNet =
    grossWeight !== null && tareWeight !== null
      ? grossWeight - tareWeight
      : null;
  const mismatch =
    netWeight !== null &&
    measuredNet !== null &&
    measuredNet > 0 &&
    measuredNet !== netWeight;
  const update = <Key extends keyof ExpenseDumpDetailsDraft>(
    key: Key,
    value: ExpenseDumpDetailsDraft[Key],
  ) => onChange({ ...draft, [key]: value });

  return (
    <fieldset className="space-y-3 rounded-xl border border-cyan-200/15 bg-cyan-200/[0.04] p-3">
      <legend className="px-1 text-xs font-bold uppercase tracking-[0.14em] text-cyan-200">
        Dump weight
      </legend>
      <p role="status" aria-live="polite" className="sr-only">
        {required
          ? "Scale ticket detected. Review the net weight."
          : "Dump-ticket fields are available."}
      </p>
      <label className="block">
        <FieldLabel>
          Net weight (lb)
          {dumpAttentionField(attentionFields, "netWeightPounds") ? (
            <AttentionBadge />
          ) : null}
        </FieldLabel>
        <input
          value={draft.netWeightPounds}
          onChange={(event) => update("netWeightPounds", event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="0"
          disabled={unreadable}
          required={required && !unreadable}
          aria-describedby={netHelpId}
          aria-invalid={
            draft.netWeightPounds.trim().length > 0 && netWeight === null
          }
          className={`${controlClass} text-lg font-semibold`}
        />
      </label>
      <p id={netHelpId} className="text-xs leading-5 text-slate-400">
        {unreadable
          ? "The ticket will be logged without weight; Overview will show it as missing."
          : netWeight
            ? formatExpenseDumpWeight(netWeight)
            : "Use the printed Net weight. Tons are calculated automatically."}
      </p>
      <label className="flex min-h-11 items-center gap-3 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={unreadable}
          onChange={(event) =>
            onChange({
              ...draft,
              weightStatus: event.target.checked ? "unreadable" : "confirmed",
              ...(event.target.checked ? { netWeightPounds: "" } : {}),
            })
          }
          className={`${focusRing} size-5 rounded border-white/20 bg-slate-950`}
        />
        <span>Net weight is unreadable</span>
      </label>
      <details className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
        <summary
          className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100`}
        >
          Scale ticket details
        </summary>
        <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
          <label className="block">
            <FieldLabel>
              Facility
              {dumpAttentionField(attentionFields, "facilityName") ? (
                <AttentionBadge />
              ) : null}
            </FieldLabel>
            <input
              value={draft.facilityName}
              onChange={(event) => update("facilityName", event.target.value)}
              maxLength={240}
              className={controlClass}
              placeholder="Optional"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>
                Ticket number
                {dumpAttentionField(attentionFields, "ticketNumber") ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <input
                value={draft.ticketNumber}
                onChange={(event) => update("ticketNumber", event.target.value)}
                maxLength={120}
                className={controlClass}
                placeholder="Optional"
              />
            </label>
            <label className="block">
              <FieldLabel>
                Material
                {dumpAttentionField(attentionFields, "material") ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <input
                value={draft.material}
                onChange={(event) => update("material", event.target.value)}
                maxLength={240}
                className={controlClass}
                placeholder="Optional"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>
                Gross weight (lb)
                {dumpAttentionField(attentionFields, "grossWeightPounds") ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <input
                value={draft.grossWeightPounds}
                onChange={(event) =>
                  update("grossWeightPounds", event.target.value)
                }
                inputMode="numeric"
                className={controlClass}
                placeholder="Optional"
              />
            </label>
            <label className="block">
              <FieldLabel>
                Tare weight (lb)
                {dumpAttentionField(attentionFields, "tareWeightPounds") ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <input
                value={draft.tareWeightPounds}
                onChange={(event) =>
                  update("tareWeightPounds", event.target.value)
                }
                inputMode="numeric"
                className={controlClass}
                placeholder="Optional"
              />
            </label>
          </div>
          {mismatch ? (
            <p className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-2 text-xs leading-5 text-amber-100">
              Gross minus tare is {formatExpenseDumpWeight(measuredNet ?? 0)}.
              Check the printed net weight before submitting.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <FieldLabel>
                Billed weight (tons)
                {dumpAttentionField(
                  attentionFields,
                  "billedWeightMilliTons",
                ) ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <input
                value={draft.billedWeightTons}
                onChange={(event) =>
                  update("billedWeightTons", event.target.value)
                }
                inputMode="decimal"
                className={controlClass}
                placeholder="Optional"
              />
            </label>
            <label className="block">
              <FieldLabel>
                Unit rate / ton
                {dumpAttentionField(attentionFields, "unitRateCentsPerTon") ? (
                  <AttentionBadge />
                ) : null}
              </FieldLabel>
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                >
                  $
                </span>
                <input
                  value={draft.unitRateDollarsPerTon}
                  onChange={(event) =>
                    update("unitRateDollarsPerTon", event.target.value)
                  }
                  inputMode="decimal"
                  aria-label="Unit rate in dollars per ton"
                  className={`${controlClass} pl-7`}
                  placeholder="Optional"
                />
              </div>
            </label>
          </div>
        </div>
      </details>
    </fieldset>
  );
}

function ExpenseEditor({
  categories,
  currentMember,
  memberOptions,
  jobs,
  canApprove,
  allowReimbursement,
  fixedCostCoverageEnabled,
  dumpTicketsEnabled,
  initial,
  attentionFields = [],
  vendorPrimary = false,
  duplicateRisk = null,
  submitting,
  submitDisabled = false,
  submitLabel,
  onBack,
  onDumpIdentityChange,
  onSubmit,
}: {
  categories: ExpenseCategory[];
  currentMember: MemberOption;
  memberOptions: MemberOption[];
  jobs: JobOption[];
  canApprove: boolean;
  allowReimbursement: boolean;
  fixedCostCoverageEnabled: boolean;
  dumpTicketsEnabled: boolean;
  initial?: Partial<{
    amount: string;
    purchaseDate: string;
    categoryId: string;
    vendor: string;
    method: string;
    documentType: "standard_receipt" | "scale_ticket" | "unknown";
    requiresScaleTicketReview: boolean;
    dumpDetails: ExpenseDumpDetailsDraft;
  }>;
  attentionFields?: string[];
  vendorPrimary?: boolean;
  duplicateRisk?: "exact" | "fuzzy" | null;
  submitting: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  onBack: () => void;
  onDumpIdentityChange?: () => void;
  onSubmit: (
    body: SubmissionBody,
    duplicateOverrideReason: string | null,
    scaleTicketDisposition: ScaleTicketDisposition,
  ) => Promise<void>;
}) {
  const [amount, setAmount] = React.useState(initial?.amount ?? "");
  const [purchaseDate, setPurchaseDate] = React.useState(
    initial?.purchaseDate ?? easternDateKey(),
  );
  const [categoryId, setCategoryId] = React.useState(initial?.categoryId ?? "");
  const [vendor, setVendor] = React.useState(initial?.vendor ?? "");
  const [payerType, setPayerType] = React.useState<"company" | "personal">(
    "company",
  );
  const [paidByMemberId, setPaidByMemberId] = React.useState(currentMember.id);
  const [notes, setNotes] = React.useState("");
  const [method, setMethod] = React.useState(initial?.method ?? "");
  const [dumpDetails, setDumpDetails] = React.useState(
    initial?.dumpDetails ?? emptyExpenseDumpDetailsDraft(),
  );
  const [appointmentId, setAppointmentId] = React.useState("");
  const [splitEnabled, setSplitEnabled] = React.useState(false);
  const [splits, setSplits] = React.useState<SplitRow[]>([]);
  const [coveredByFixedCostSeriesId, setCoveredByFixedCostSeriesId] =
    React.useState("");
  const [overrideReason, setOverrideReason] = React.useState("");
  const [notScaleTicket, setNotScaleTicket] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const detectedScaleTicket = Boolean(
    dumpTicketsEnabled &&
      (initial?.documentType === "scale_ticket" ||
        initial?.requiresScaleTicketReview),
  );
  const hasInitialDumpDetails = Boolean(
    dumpTicketsEnabled &&
      initial?.dumpDetails &&
      (expenseDumpDraftHasData(initial.dumpDetails) ||
        initial.dumpDetails.weightStatus === "unreadable"),
  );
  const dumpCategorySelected =
    categoryId === "dump_fees" ||
    (splitEnabled && splits.some((row) => row.categoryId === "dump_fees"));
  const showDumpDetails = Boolean(
    dumpTicketsEnabled &&
      !notScaleTicket &&
      (detectedScaleTicket || hasInitialDumpDetails || dumpCategorySelected),
  );

  React.useEffect(() => {
    if (!allowReimbursement) {
      setPayerType("company");
      setPaidByMemberId(currentMember.id);
    }
  }, [allowReimbursement, currentMember.id]);
  const vendorField = (
    <label className="block">
      <FieldLabel>
        Vendor {attentionFields.includes("vendor") ? <AttentionBadge /> : null}
      </FieldLabel>
      <input
        value={vendor}
        onChange={(event) => setVendor(event.target.value)}
        maxLength={240}
        className={controlClass}
        placeholder="Optional"
      />
    </label>
  );

  const enableSplits = () => {
    if (splitEnabled) {
      setSplitEnabled(false);
      setSplits([]);
      return;
    }
    setCoveredByFixedCostSeriesId("");
    setSplitEnabled(true);
    setSplits([
      { key: crypto.randomUUID(), categoryId, amount },
      { key: crypto.randomUUID(), categoryId: "", amount: "" },
    ]);
  };

  const updatePrimaryCategory = (value: string) => {
    setCategoryId(value);
    setSplits((current) =>
      current.map((row, index) =>
        index === 0 ? { ...row, categoryId: value } : row,
      ),
    );
  };

  const updateAmount = (value: string) => {
    setAmount(value);
    if (!splitEnabled) return;
    setSplits((current) =>
      current.map((row, index) =>
        index === 0 ? { ...row, amount: value } : row,
      ),
    );
  };

  const updateDumpDetails = (next: ExpenseDumpDetailsDraft) => {
    if (
      next.facilityName !== dumpDetails.facilityName ||
      next.ticketNumber !== dumpDetails.ticketNumber
    ) {
      setOverrideReason("");
      onDumpIdentityChange?.();
    }
    setDumpDetails(next);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const amountCents = moneyInputToCents(amount);
    if (amountCents === null || amountCents < 1) {
      setError("Enter an expense amount greater than $0.00.");
      return;
    }
    if (!purchaseDate || purchaseDate > easternDateKey()) {
      setError("Choose today or an earlier purchase date.");
      return;
    }
    if (!categoryId) {
      setError("Choose an expense category.");
      return;
    }
    const parsedDumpDetails = showDumpDetails
      ? buildExpenseDumpSubmissionDetails(dumpDetails, {
          required: detectedScaleTicket,
        })
      : ({ ok: true, details: null } as const);
    if (!parsedDumpDetails.ok) {
      setError(parsedDumpDetails.message);
      return;
    }
    let allocations: SubmissionBody["allocations"];
    if (splitEnabled) {
      allocations = splits.map((row) => ({
        categoryId: row.categoryId,
        amountCents: moneyInputToCents(row.amount) ?? 0,
      }));
      if (allocations.some((row) => !row.categoryId || row.amountCents < 1)) {
        setError("Every category split needs a category and an amount.");
        return;
      }
      if (
        new Set(allocations.map((row) => row.categoryId)).size !==
        allocations.length
      ) {
        setError("Combine duplicate categories into one split row.");
        return;
      }
      if (expenseAllocationTotal(allocations) !== amountCents) {
        setError(
          `Category splits must equal ${formatExpenseMoney(amountCents)} exactly.`,
        );
        return;
      }
    }
    if (coveredByFixedCostSeriesId) {
      if (splitEnabled) {
        setError("Use one category before linking this to a fixed cost.");
        return;
      }
      const response = await fetch(
        `/api/mobile/expenses/fixed-costs?asOf=${encodeURIComponent(purchaseDate)}`,
        { cache: "no-store", credentials: "include" },
      ).catch(() => null);
      const payload = response ? await jsonPayload(response) : null;
      const fixedCosts = response?.ok
        ? parseMobileFixedCostsPayload(payload)
        : null;
      const coveredCost = fixedCosts?.costs.find(
        (cost) =>
          cost.seriesId === coveredByFixedCostSeriesId &&
          cost.state === "active",
      );
      if (!coveredCost) {
        setError(
          "Refresh the fixed-cost selection. That schedule is no longer active for this date.",
        );
        return;
      }
      if (
        coveredCost.monthlyAmountCents !== amountCents ||
        coveredCost.categoryId !== categoryId
      ) {
        setError(
          `Match ${coveredCost.name} to ${formatExpenseMoney(coveredCost.monthlyAmountCents)} and ${coveredCost.category} before submitting.`,
        );
        return;
      }
    }
    if (
      duplicateRisk === "exact" &&
      (!canApprove || overrideReason.trim().length < 10)
    ) {
      setError(
        canApprove
          ? "Add at least 10 characters explaining this duplicate override."
          : "Only an owner can override a matching receipt or scale ticket.",
      );
      return;
    }
    await onSubmit(
      {
        amountCents,
        purchaseDate,
        categoryId,
        ...(allocations ? { allocations } : {}),
        ...(coveredByFixedCostSeriesId ? { coveredByFixedCostSeriesId } : {}),
        vendor: vendor.trim() || null,
        notes: notes.trim() || null,
        method: method ? (method as SubmissionBody["method"]) : null,
        payerType,
        paidByMemberId: payerType === "personal" ? paidByMemberId : null,
        appointmentId: appointmentId || null,
        ...(parsedDumpDetails.details
          ? { dumpDetails: parsedDumpDetails.details }
          : {}),
      },
      duplicateRisk === "exact" ? overrideReason.trim() || null : null,
      detectedScaleTicket && notScaleTicket ? "not_scale_ticket" : null,
    );
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      {duplicateRisk ? (
        <StatusNotice
          tone={duplicateRisk === "exact" ? "error" : "info"}
          message={
            duplicateRisk === "exact"
              ? canApprove
                ? "This matches an existing receipt or scale ticket. Confirm why it should be entered again."
                : "This may duplicate an existing receipt or scale ticket. An owner must review it before it can be submitted."
              : "This looks similar to a nearby receipt. Review the details carefully before submitting."
          }
        />
      ) : null}

      {vendorPrimary ? vendorField : null}

      <label className="block">
        <FieldLabel>
          Date{" "}
          {attentionFields.includes("transactionDate") ? (
            <AttentionBadge />
          ) : null}
        </FieldLabel>
        <input
          type="date"
          value={purchaseDate}
          max={easternDateKey()}
          required
          onChange={(event) => setPurchaseDate(event.target.value)}
          className={controlClass}
        />
      </label>

      <label className="block">
        <FieldLabel>
          Amount{" "}
          {attentionFields.includes("totalCents") ? <AttentionBadge /> : null}
        </FieldLabel>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xl font-semibold text-slate-400"
          >
            $
          </span>
          <input
            value={amount}
            onChange={(event) => updateAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            required
            aria-label="Expense amount in dollars"
            className={`${controlClass} pl-8 text-xl font-semibold`}
          />
        </div>
      </label>

      <label className="block">
        <FieldLabel>
          Category{" "}
          {attentionFields.includes("suggestedCategoryId") ? (
            <AttentionBadge />
          ) : null}
        </FieldLabel>
        <select
          value={categoryId}
          onChange={(event) => updatePrimaryCategory(event.target.value)}
          required
          className={controlClass}
        >
          <option value="">Choose category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>

      {detectedScaleTicket ? (
        <div className="rounded-xl border border-cyan-300/25 bg-cyan-300/[0.06] p-3">
          <p className="text-sm font-semibold text-cyan-100">
            Scanner identified a scale ticket
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            Confirm the printed weight below. If this is an ordinary receipt,
            use the option here so no weight is stored.
          </p>
          <label className="mt-2 flex min-h-11 items-center gap-3 rounded-lg border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={notScaleTicket}
              onChange={(event) => {
                setNotScaleTicket(event.target.checked);
                setOverrideReason("");
                onDumpIdentityChange?.();
              }}
              className={`${focusRing} size-5 rounded border-white/20 bg-slate-950`}
            />
            <span>This is not a scale ticket</span>
          </label>
          {notScaleTicket ? (
            <p className="mt-2 text-xs font-semibold text-amber-100">
              Weight details will not be saved. Double-check the category before
              submitting.
            </p>
          ) : null}
        </div>
      ) : null}

      {showDumpDetails ? (
        <DumpTicketFields
          draft={dumpDetails}
          onChange={updateDumpDetails}
          required={detectedScaleTicket}
          attentionFields={attentionFields}
        />
      ) : null}

      {allowReimbursement ? (
        <fieldset>
          <legend className="text-xs font-semibold text-slate-300">
            Who paid?
          </legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {(["company", "personal"] as const).map((value) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-3 text-sm font-semibold outline-none focus-within:ring-2 focus-within:ring-cyan-200 focus-within:ring-offset-2 focus-within:ring-offset-slate-950 ${payerType === value ? "border-cyan-300 bg-cyan-300/10 text-cyan-100" : "border-white/15 bg-slate-950 text-slate-300"}`}
              >
                <input
                  type="radio"
                  name="payerType"
                  value={value}
                  checked={payerType === value}
                  onChange={() => setPayerType(value)}
                  className="sr-only"
                />
                {value === "company"
                  ? "Company"
                  : canApprove
                    ? "Personal"
                    : "I paid"}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <div>
          <FieldLabel>Who paid?</FieldLabel>
          <p className="flex min-h-11 items-center rounded-lg border border-white/15 bg-slate-950 px-3 text-sm font-semibold text-slate-200">
            Company
          </p>
        </div>
      )}

      {payerType === "personal" ? (
        canApprove ? (
          <label className="block">
            <FieldLabel>Paid by</FieldLabel>
            <select
              value={paidByMemberId}
              onChange={(event) => setPaidByMemberId(event.target.value)}
              className={controlClass}
              required
            >
              {memberOptions.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2.5 text-sm text-slate-300">
            Reimbursement will be requested for {currentMember.name} after owner
            approval.
          </p>
        )
      ) : null}

      <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
        <summary
          className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100`}
        >
          More details
        </summary>
        <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
          {vendorPrimary ? null : vendorField}
          <label className="block">
            <FieldLabel>Notes</FieldLabel>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={3}
              className={controlClass}
              placeholder="Optional"
            />
          </label>
          <label className="block">
            <FieldLabel>Payment method</FieldLabel>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              className={controlClass}
            >
              <option value="">Not specified</option>
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="ach">ACH</option>
              <option value="check">Check</option>
              <option value="zelle">Zelle</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block">
            <FieldLabel>Job link</FieldLabel>
            <select
              value={appointmentId}
              onChange={(event) => setAppointmentId(event.target.value)}
              className={controlClass}
            >
              <option value="">No job linked</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.date} · {job.label}
                </option>
              ))}
            </select>
          </label>
          <FixedCostCoverageField
            enabled={fixedCostCoverageEnabled}
            purchaseDate={purchaseDate}
            amountCents={moneyInputToCents(amount)}
            categoryId={categoryId}
            splitEnabled={splitEnabled}
            value={coveredByFixedCostSeriesId}
            onChange={setCoveredByFixedCostSeriesId}
          />
          <div>
            <button
              type="button"
              onClick={enableSplits}
              className={`${secondaryButton} w-full`}
            >
              {splitEnabled ? "Use one category" : "Split categories"}
            </button>
            {splitEnabled ? (
              <div className="mt-3 space-y-3">
                {splits.map((row, index) => (
                  <div
                    key={row.key}
                    className="rounded-lg border border-white/10 bg-slate-950 p-3"
                  >
                    <p className="mb-2 text-xs font-semibold text-slate-400">
                      Split {index + 1}
                    </p>
                    <select
                      aria-label={`Category for split ${index + 1}`}
                      value={row.categoryId}
                      disabled={index === 0}
                      onChange={(event) =>
                        setSplits((current) =>
                          current.map((candidate) =>
                            candidate.key === row.key
                              ? { ...candidate, categoryId: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      className={controlClass}
                    >
                      <option value="">Choose category</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`Amount for split ${index + 1}`}
                      value={row.amount}
                      onChange={(event) =>
                        setSplits((current) =>
                          current.map((candidate) =>
                            candidate.key === row.key
                              ? { ...candidate, amount: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      inputMode="decimal"
                      placeholder="0.00"
                      className={`${controlClass} mt-2`}
                    />
                    {index > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSplits((current) =>
                            current.filter(
                              (candidate) => candidate.key !== row.key,
                            ),
                          )
                        }
                        className={`${secondaryButton} mt-2 w-full`}
                      >
                        Remove split
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setSplits((current) => [
                      ...current,
                      { key: crypto.randomUUID(), categoryId: "", amount: "" },
                    ])
                  }
                  className={`${secondaryButton} w-full`}
                >
                  Add another category
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </details>

      {duplicateRisk === "exact" && canApprove ? (
        <label className="block">
          <FieldLabel>Duplicate override reason</FieldLabel>
          <textarea
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            minLength={10}
            maxLength={500}
            rows={2}
            className={controlClass}
            required
          />
        </label>
      ) : null}

      {error ? <StatusNotice tone="error" message={error} /> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {submitting ? "Submitting expense" : ""}
      </div>
      <button
        type="submit"
        disabled={
          submitting ||
          submitDisabled ||
          (duplicateRisk === "exact" && !canApprove)
        }
        className={primaryButton}
      >
        {submitting ? "Working…" : submitLabel}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        className={`${secondaryButton} w-full`}
      >
        Back
      </button>
    </form>
  );
}

function receiptDumpReviewValue(input: {
  fields: Record<string, unknown> | null;
  rawDumpTicket: Record<string, unknown> | null;
  name: keyof Omit<ExpenseDumpDetails, "weightStatus">;
}): unknown {
  const reviewedDump =
    objectValue(input.fields?.["dumpTicket"]) ??
    objectValue(input.fields?.["dumpDetails"]);
  const reviewedValue = objectValue(reviewedDump?.["value"]);
  if (reviewedValue && input.name in reviewedValue) {
    return reviewedValue[input.name];
  }
  const nestedFields = objectValue(reviewedDump?.["fields"]);
  const nestedField =
    objectValue(nestedFields?.[input.name]) ??
    objectValue(reviewedDump?.[input.name]);
  if (nestedField && "value" in nestedField) return nestedField["value"];
  if (reviewedDump && input.name in reviewedDump) {
    return reviewedDump[input.name];
  }
  const rolloutField = objectValue(input.fields?.[input.name]);
  if (rolloutField && "value" in rolloutField) return rolloutField["value"];
  return input.rawDumpTicket?.[input.name];
}

export function receiptExtractionFromCapture(
  capture: Record<string, unknown> | null,
): {
  initial: Parameters<typeof ExpenseEditor>[0]["initial"];
  attention: string[];
  duplicateRisk: "exact" | "fuzzy" | null;
} {
  const extraction = objectValue(capture?.["extraction"]);
  const review = objectValue(extraction?.["review"]);
  const fields = objectValue(review?.["fields"]);
  const fieldValue = (name: string): unknown =>
    objectValue(fields?.[name])?.["value"];
  const categorySuggestion = objectValue(extraction?.["categorySuggestion"]);
  const duplicates = objectValue(extraction?.["duplicates"]);
  const rawSource =
    extraction && "raw" in extraction ? extraction["raw"] : extraction;
  const raw = objectValue(rawSource);
  const requiresScaleTicketReview = Boolean(
    raw &&
      (raw["documentType"] === "scale_ticket" ||
        raw["receiptType"] === "scale_ticket" ||
        ("dumpTicket" in raw && raw["dumpTicket"] !== null) ||
        ("dumpDetails" in raw && raw["dumpDetails"] !== null)),
  );
  const rawDumpTicket =
    objectValue(raw?.["dumpTicket"]) ?? objectValue(raw?.["dumpDetails"]);
  const rawDocumentType = raw?.["documentType"] ?? raw?.["receiptType"];
  const documentType =
    rawDocumentType === "scale_ticket" ||
    rawDocumentType === "standard_receipt" ||
    rawDocumentType === "unknown"
      ? rawDocumentType
      : "unknown";
  const dumpValue = (
    name: keyof Omit<ExpenseDumpDetails, "weightStatus">,
  ): unknown => receiptDumpReviewValue({ fields, rawDumpTicket, name });
  const dumpDetails: ExpenseDumpDetails = {
    weightStatus: "confirmed",
    facilityName: nullableExpenseString(dumpValue("facilityName")),
    ticketNumber: nullableExpenseString(dumpValue("ticketNumber")),
    material: nullableExpenseString(dumpValue("material")),
    grossWeightPounds: nullableExpenseInteger(dumpValue("grossWeightPounds")),
    tareWeightPounds: nullableExpenseInteger(dumpValue("tareWeightPounds")),
    netWeightPounds: nullableExpenseInteger(dumpValue("netWeightPounds")),
    billedWeightMilliTons: nullableExpenseInteger(
      dumpValue("billedWeightMilliTons"),
    ),
    unitRateCentsPerTon: nullableExpenseInteger(
      dumpValue("unitRateCentsPerTon"),
    ),
  };
  const total = fieldValue("totalCents");
  const lastFour = fieldValue("paymentLastFour");
  const highestRisk = duplicates?.["highestRisk"];
  return {
    initial: {
      amount: typeof total === "number" ? centsToMoneyInput(total) : "",
      purchaseDate:
        typeof fieldValue("transactionDate") === "string"
          ? String(fieldValue("transactionDate"))
          : "",
      categoryId:
        typeof categorySuggestion?.["categoryId"] === "string"
          ? categorySuggestion["categoryId"]
          : typeof fieldValue("suggestedCategoryId") === "string"
            ? String(fieldValue("suggestedCategoryId"))
            : "",
      vendor:
        typeof fieldValue("vendor") === "string"
          ? String(fieldValue("vendor"))
          : "",
      method:
        typeof lastFour === "string" ||
        typeof raw?.["paymentLastFour"] === "string"
          ? "card"
          : "",
      documentType,
      requiresScaleTicketReview,
      dumpDetails: expenseDumpDetailsDraft(dumpDetails),
    },
    attention: Array.isArray(review?.["fieldsToCheck"])
      ? review["fieldsToCheck"].filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    duplicateRisk:
      capture?.["exactDuplicateOfCaptureId"] || highestRisk === "exact"
        ? "exact"
        : highestRisk === "fuzzy"
          ? "fuzzy"
          : null,
  };
}

function receiptExtraction(
  row: ExpenseCaptureQueueRow,
): ReturnType<typeof receiptExtractionFromCapture> {
  return receiptExtractionFromCapture(row.serverCapture);
}

function ReceiptWorkflow({
  row,
  employeeId,
  categories,
  currentMember,
  members,
  jobs,
  canApprove,
  allowReimbursement,
  fixedCostCoverageEnabled,
  dumpTicketsEnabled,
  onRow,
  onDone,
  onBack,
}: {
  row: ExpenseCaptureQueueRow | null;
  employeeId: string;
  categories: ExpenseCategory[];
  currentMember: MemberOption;
  members: MemberOption[];
  jobs: JobOption[];
  canApprove: boolean;
  allowReimbursement: boolean;
  fixedCostCoverageEnabled: boolean;
  dumpTicketsEnabled: boolean;
  onRow: (row: ExpenseCaptureQueueRow | null) => void;
  onDone: (message: string) => void;
  onBack: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const extractionInFlightRef = React.useRef(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [isOnline, setIsOnline] = React.useState(true);
  const [runtimeDuplicateKind, setRuntimeDuplicateKind] = React.useState<
    "scale_ticket" | "exact_receipt" | null
  >(null);

  React.useEffect(() => {
    setRuntimeDuplicateKind(null);
  }, [row?.clientCaptureId]);

  React.useEffect(() => {
    setIsOnline(navigator.onLine);
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  React.useEffect(() => {
    if (!row?.bytes) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([row.bytes], { type: row.contentType }),
    );
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [row?.bytes, row?.contentType]);

  const selectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      if (row?.status === "draft") {
        await removeExpenseCapture(row.clientCaptureId).catch(() => undefined);
      }
      const created = await createExpenseCaptureDraft(employeeId, file);
      onRow(created);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The receipt could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const startExtraction = async () => {
    if (!row || extractionInFlightRef.current) return;
    extractionInFlightRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const queued = await queueExpenseCapture(row.clientCaptureId);
      onRow(queued);
      const synchronized = await syncExpenseCapture(row.clientCaptureId);
      onRow(synchronized);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The receipt could not start syncing. Retry when connected.",
      );
    } finally {
      extractionInFlightRef.current = false;
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!row) return onBack();
    setBusy(true);
    setMessage(null);
    if (row.status !== "draft") {
      if (!navigator.onLine) {
        setMessage(
          "Reconnect before discarding so the server can retain the receipt evidence safely.",
        );
        setBusy(false);
        return;
      }
      try {
        const response = await fetch(
          `/api/mobile/expenses/captures/${encodeURIComponent(row.clientCaptureId)}`,
          {
            method: "DELETE",
            credentials: "include",
          },
        );
        const payload = await jsonPayload(response);
        if (!response.ok) {
          const refreshed = await refreshExpenseCapture(
            row.clientCaptureId,
          ).catch(() => null);
          if (refreshed) onRow(refreshed);
          setMessage(
            expenseErrorMessage(
              payload,
              "The receipt was not discarded. It remains safely stored.",
            ),
          );
          setBusy(false);
          return;
        }
      } catch {
        const refreshed = await refreshExpenseCapture(
          row.clientCaptureId,
        ).catch(() => null);
        if (refreshed) onRow(refreshed);
        setMessage(
          "The discard response was interrupted. The receipt remains stored; retry when connected.",
        );
        setBusy(false);
        return;
      }
    }
    try {
      await removeExpenseCapture(row.clientCaptureId);
      onRow(null);
      setBusy(false);
      onBack();
    } catch {
      const refreshed =
        row.status === "draft"
          ? null
          : await refreshExpenseCapture(row.clientCaptureId).catch(() => null);
      if (refreshed) onRow(refreshed);
      setMessage(
        row.status === "draft"
          ? "This device could not clear the draft. Retry before leaving this receipt."
          : "The server discarded the receipt, but this device could not clear its local copy. Retry the local cleanup.",
      );
      setBusy(false);
    }
  };

  const finishConfirmed = async () => {
    if (!row) return;
    setBusy(true);
    await removeExpenseCapture(row.clientCaptureId).catch(() => undefined);
    onRow(null);
    setBusy(false);
    onDone("Expense submission confirmed.");
  };

  const finishDiscarded = async () => {
    if (!row) return;
    setBusy(true);
    setMessage(null);
    try {
      await removeExpenseCapture(row.clientCaptureId);
      onRow(null);
      onBack();
    } catch {
      setMessage("This device could not clear the discarded receipt yet.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (
    body: SubmissionBody,
    overrideReason: string | null,
    scaleTicketDisposition: ScaleTicketDisposition,
  ) => {
    if (!row?.serverCapture) return;
    const version = row.serverCapture["version"];
    if (typeof version !== "number") {
      setMessage("Refresh the receipt analysis before submitting.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const requestBody = {
      ...body,
      ...(dumpTicketsEnabled ? { receiptReviewContractVersion: 2 } : {}),
      ...(overrideReason
        ? { exactDuplicateOverrideReason: overrideReason }
        : {}),
      ...(scaleTicketDisposition ? { scaleTicketDisposition } : {}),
    };
    let attempt: Awaited<ReturnType<typeof getExpenseMutationAttempt>> | null =
      null;
    try {
      attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: `receipt-confirm:${row.clientCaptureId}`,
        payload: { version, body: requestBody },
      });
      const response = await fetch(
        `/api/mobile/expenses/captures/${encodeURIComponent(row.clientCaptureId)}/confirm`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKey,
            "If-Match": String(version),
          },
          body: JSON.stringify(requestBody),
        },
      );
      const payload = await jsonPayload(response);
      if (!response.ok) {
        const duplicateKind = expenseConfirmationDuplicateKind(
          response.status,
          payload,
          {
            attemptedDumpDetails: body.dumpDetails !== undefined,
            knownExactReceipt:
              receiptExtraction(row).duplicateRisk === "exact",
          },
        );
        if (duplicateKind) setRuntimeDuplicateKind(duplicateKind);
        if (response.status === 409 || response.status === 412) {
          const refreshed = await refreshExpenseCapture(
            row.clientCaptureId,
          ).catch(() => null);
          if (refreshed) {
            onRow(refreshed);
            if (refreshed.status === "confirmed") {
              await acknowledgeExpenseMutationAttempt(attempt);
              setMessage(null);
              return;
            }
          }
        }
        setMessage(
          expenseErrorMessage(
            payload,
            "The receipt expense was not submitted.",
          ),
        );
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      await removeExpenseCapture(row.clientCaptureId).catch(() => undefined);
      onRow(null);
      const data = objectValue(payload?.["data"]);
      onDone(
        data?.["reviewStatus"] === "pending"
          ? "Expense submitted for owner approval."
          : "Expense posted.",
      );
    } catch (error) {
      if (attempt) {
        const refreshed = await refreshExpenseCapture(
          row.clientCaptureId,
        ).catch(() => null);
        if (refreshed) {
          onRow(refreshed);
          if (refreshed.status === "confirmed") {
            await acknowledgeExpenseMutationAttempt(attempt).catch(
              () => undefined,
            );
            setMessage(null);
            return;
          }
        }
      }
      setMessage(
        error instanceof Error &&
          error.message.startsWith("Secure expense retry storage")
          ? error.message
          : "The connection was interrupted. Nothing was reported as posted; retry the same review.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!row) {
    return (
      <div className={`${cardClass} space-y-4`}>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
            Scan receipt
          </p>
          <h2 className="mt-1 text-lg font-semibold">Take a clear photo</h2>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            Portrait or landscape, keep all four corners in frame. On scale
            tickets, make the weight block and total easy to read. You will
            review every value before it posts.
          </p>
        </div>
        {message ? <StatusNotice tone="error" message={message} /> : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
          capture="environment"
          onChange={(event) => void selectFile(event)}
          className="sr-only"
          aria-label="Choose receipt photo or PDF"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className={primaryButton}
        >
          <Camera aria-hidden="true" className="mr-2 inline size-5" />
          {busy ? "Saving receipt…" : "Open camera"}
        </button>
        <button
          type="button"
          onClick={onBack}
          className={`${secondaryButton} w-full`}
        >
          Back
        </button>
      </div>
    );
  }

  if (row.status === "draft") {
    return (
      <div className={`${cardClass} space-y-4`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
              Preview
            </p>
            <h2 className="mt-1 text-lg font-semibold">Use this receipt?</h2>
          </div>
          <button
            type="button"
            onClick={() => void discard()}
            aria-label="Discard receipt"
            className={`${secondaryButton} aspect-square p-2.5`}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        {message ? <StatusNotice tone="error" message={message} /> : null}
        {previewUrl &&
        row.contentType.startsWith("image/") &&
        !row.contentType.includes("heic") &&
        !row.contentType.includes("heif") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Receipt preview"
            className="max-h-[55dvh] w-full rounded-lg bg-white object-contain"
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-white/15 bg-slate-900 p-4 text-center">
            <div>
              <FileText
                aria-hidden="true"
                className="mx-auto size-8 text-cyan-200"
              />
              <p className="mt-2 text-sm font-semibold">{row.filename}</p>
              <p className="mt-1 text-xs text-slate-400">
                Preview is not available for this file type.
              </p>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => void startExtraction()}
          disabled={busy}
          className={primaryButton}
        >
          {busy ? "Preparing…" : "Extract receipt details"}
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={`${secondaryButton} w-full`}
        >
          Retake
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
          capture="environment"
          onChange={(event) => void selectFile(event)}
          className="sr-only"
          aria-label="Choose a replacement receipt photo or PDF"
        />
      </div>
    );
  }

  if (row.status === "queued" || row.status === "syncing") {
    return (
      <div className={`${cardClass} space-y-4 text-center`}>
        <Clock3 aria-hidden="true" className="mx-auto size-9 text-cyan-200" />
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2 className="text-lg font-semibold">Waiting to sync</h2>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            The original is safe on this device. Keep StonegateOS open or
            reconnect to continue.
          </p>
        </div>
        {message ? <StatusNotice tone="error" message={message} /> : null}
        {row.error ? <StatusNotice tone="error" message={row.error} /> : null}
        <button
          type="button"
          disabled={busy || !isOnline}
          onClick={() => void startExtraction()}
          className={primaryButton}
        >
          <RotateCcw aria-hidden="true" className="mr-2 inline size-4" />
          Retry now
        </button>
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy}
          className={`${secondaryButton} w-full`}
        >
          Discard receipt
        </button>
      </div>
    );
  }

  if (row.status === "processing") {
    return (
      <div className={`${cardClass} space-y-4 text-center`}>
        <ReceiptText
          aria-hidden="true"
          className="mx-auto size-9 animate-pulse text-cyan-200"
        />
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2 className="text-lg font-semibold">Reading receipt</h2>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            You can leave and come back. Nothing can post until you review it.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className={`${secondaryButton} w-full`}
        >
          Back to Spend
        </button>
      </div>
    );
  }

  if (row.status === "confirmed") {
    return (
      <div className={`${cardClass} space-y-4`}>
        <StatusNotice
          tone="success"
          message="This receipt was already confirmed. It cannot be submitted twice."
        />
        <button
          type="button"
          onClick={() => void finishConfirmed()}
          disabled={busy}
          className={primaryButton}
        >
          {busy ? "Finishing…" : "Finish"}
        </button>
      </div>
    );
  }

  if (row.status === "discarded") {
    return (
      <div className={`${cardClass} space-y-4`}>
        {message ? <StatusNotice tone="error" message={message} /> : null}
        <StatusNotice
          tone="info"
          message="The receipt was discarded on the server. Its original evidence remains protected there."
        />
        <button
          type="button"
          onClick={() => void finishDiscarded()}
          disabled={busy}
          className={primaryButton}
        >
          {busy ? "Clearing…" : "Clear from this device"}
        </button>
      </div>
    );
  }

  if (row.status === "failed") {
    return (
      <div className={`${cardClass} space-y-4`}>
        {message ? <StatusNotice tone="error" message={message} /> : null}
        <StatusNotice
          tone="error"
          message={row.error ?? "The receipt could not be analyzed."}
        />
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm leading-6 text-slate-300"
        >
          Analysis stopped and no expense was posted. Discard this attempt, then
          retake the receipt or use Manual entry.
        </p>
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy || !isOnline}
          className={primaryButton}
        >
          {busy ? "Discarding…" : "Discard failed receipt"}
        </button>
        <button
          type="button"
          onClick={onBack}
          className={`${secondaryButton} w-full`}
        >
          Back to Spend
        </button>
      </div>
    );
  }

  const extracted = receiptExtraction(row);
  const receiptContentHref = expenseCaptureEvidenceHref(row.serverCapture);
  return (
    <div className={cardClass}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
            Review receipt
          </p>
          <h2 className="mt-1 text-lg font-semibold">Confirm every value</h2>
          <p className="mt-1 text-sm text-slate-300">
            The scan only prefills this form.
          </p>
          {receiptContentHref ? (
            <a
              href={receiptContentHref}
              target="_blank"
              rel="noreferrer"
              className={`${focusRing} mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/15 bg-slate-900 px-3 text-sm font-semibold text-white`}
            >
              <FileText aria-hidden="true" className="size-4" />
              View receipt
            </a>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy}
          aria-label="Discard receipt"
          className={`${secondaryButton} aspect-square shrink-0 p-2.5`}
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      {message ? (
        <div className="mb-4">
          <StatusNotice tone="error" message={message} />
        </div>
      ) : null}
      <ExpenseEditor
        key={`${row.clientCaptureId}:${typeof row.serverCapture?.["version"] === "number" ? row.serverCapture["version"] : 0}`}
        categories={categories}
        currentMember={currentMember}
        memberOptions={members}
        jobs={jobs}
        canApprove={canApprove}
        allowReimbursement={allowReimbursement}
        fixedCostCoverageEnabled={fixedCostCoverageEnabled}
        dumpTicketsEnabled={dumpTicketsEnabled}
        initial={extracted.initial}
        attentionFields={extracted.attention}
        vendorPrimary
        duplicateRisk={
          extracted.duplicateRisk === "exact" || runtimeDuplicateKind
            ? "exact"
            : extracted.duplicateRisk
        }
        submitting={busy}
        submitLabel={canApprove ? "Post expense" : "Submit for approval"}
        onBack={onBack}
        onDumpIdentityChange={() => {
          if (runtimeDuplicateKind === "scale_ticket") {
            setRuntimeDuplicateKind(null);
            setMessage(null);
          }
        }}
        onSubmit={confirm}
      />
    </div>
  );
}

function DailyAdWorkflow({
  employeeId,
  initialDate,
  onBack,
  onSaved,
}: {
  employeeId: string;
  initialDate: string;
  onBack: () => void;
  onSaved: (message: string) => void;
}) {
  const [date, setDate] = React.useState(initialDate);
  const [day, setDay] = React.useState<DailyAdDay | null>(null);
  const [facebook, setFacebook] = React.useState("");
  const [google, setGoogle] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(
      `/api/mobile/expenses/daily-ad-spend?businessDate=${encodeURIComponent(date)}`,
      { cache: "no-store" },
    )
      .then(async (response) => ({
        response,
        payload: await jsonPayload(response),
      }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok)
          throw new Error(
            expenseErrorMessage(payload, "Daily ad spend is unavailable."),
          );
        const next: DailyAdDay = {
          businessDate:
            typeof payload?.["businessDate"] === "string"
              ? payload["businessDate"]
              : date,
          facebook: dailyAdEntry(payload?.["facebook"]),
          google: dailyAdEntry(payload?.["google"]),
        };
        setDay(next);
        setFacebook(
          next.facebook ? centsToMoneyInput(next.facebook.amountCents) : "",
        );
        setGoogle(
          next.google ? centsToMoneyInput(next.google.amountCents) : "",
        );
      })
      .catch(
        (reason: unknown) =>
          active &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Daily ad spend is unavailable.",
          ),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [date]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const facebookCents = facebook.trim() ? moneyInputToCents(facebook) : null;
    const googleCents = google.trim() ? moneyInputToCents(google) : null;
    if (facebookCents === null && googleCents === null) {
      setError(
        "Enter Facebook, Google, or both. Use 0.00 to confirm no spend.",
      );
      return;
    }
    if (
      (facebook.trim() && facebookCents === null) ||
      (google.trim() && googleCents === null)
    ) {
      setError("Enter each ad amount in dollars and cents.");
      return;
    }
    setSaving(true);
    try {
      const requestBody = {
        businessDate: date,
        facebook:
          facebookCents === null
            ? null
            : {
                amountCents: facebookCents,
                version: day?.facebook?.version ?? null,
              },
        google:
          googleCents === null
            ? null
            : {
                amountCents: googleCents,
                version: day?.google?.version ?? null,
              },
      };
      const attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: `daily-ad-spend:${date}`,
        payload: requestBody,
      });
      const response = await fetch("/api/mobile/expenses/daily-ad-spend", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
      const payload = await jsonPayload(response);
      if (!response.ok) {
        setError(expenseErrorMessage(payload, "Ad spend was not saved."));
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      onSaved(`Ad spend confirmed for ${date}.`);
    } catch (reason) {
      setError(
        reason instanceof Error &&
          reason.message.startsWith("Secure expense retry storage")
          ? reason.message
          : "The connection was interrupted. Retry to confirm the same values safely.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void save(event)}
      className={`${cardClass} space-y-4`}
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
          Daily ad spend
        </p>
        <h2 className="mt-1 text-lg font-semibold">Facebook and Google</h2>
        <p className="mt-1 text-sm leading-6 text-slate-300">
          Manual values are authoritative. Enter 0.00 to confirm zero.
        </p>
      </div>
      <label className="block">
        <FieldLabel>Business date</FieldLabel>
        <input
          type="date"
          value={date}
          max={easternDateKey()}
          onChange={(event) => setDate(event.target.value)}
          className={controlClass}
        />
      </label>
      <button
        type="button"
        onClick={() => setDate(easternDateKey())}
        className={`${secondaryButton} w-full`}
      >
        Today
      </button>
      <label className="block">
        <FieldLabel>Facebook</FieldLabel>
        <div className="relative">
          <span
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          >
            $
          </span>
          <input
            aria-label="Facebook ad spend in dollars"
            value={facebook}
            onChange={(event) => setFacebook(event.target.value)}
            inputMode="decimal"
            placeholder="Not entered"
            disabled={loading}
            className={`${controlClass} pl-7`}
          />
        </div>
      </label>
      <label className="block">
        <FieldLabel>Google</FieldLabel>
        <div className="relative">
          <span
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          >
            $
          </span>
          <input
            aria-label="Google ad spend in dollars"
            value={google}
            onChange={(event) => setGoogle(event.target.value)}
            inputMode="decimal"
            placeholder="Not entered"
            disabled={loading}
            className={`${controlClass} pl-7`}
          />
        </div>
      </label>
      {error ? <StatusNotice tone="error" message={error} /> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {loading ? "Loading ad spend" : saving ? "Saving ad spend" : ""}
      </div>
      <button
        type="submit"
        disabled={loading || saving}
        className={primaryButton}
      >
        {saving ? "Saving…" : "Save ad spend"}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={saving}
        className={`${secondaryButton} w-full`}
      >
        Back
      </button>
    </form>
  );
}

type OverviewReasonCounts = {
  pendingExpenseCount: number;
  missingAdEntries: Array<unknown>;
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
  omittedUnverifiedHistoricalRecordCount: number;
  unverifiedExpenseCategoryCount: number;
};

export function expenseOverviewReasonDetail(
  reason: ExpenseOverviewIncompleteReason,
  period: OverviewReasonCounts,
): string {
  switch (reason) {
    case "missing_ad_entries":
      return `${period.missingAdEntries.length} day${period.missingAdEntries.length === 1 ? "" : "s"} missing Facebook or Google ad entries`;
    case "missing_commission_data":
      return `${period.missingCommissionDataCount} completed job${period.missingCommissionDataCount === 1 ? "" : "s"} missing commission data`;
    case "missing_final_totals":
      return `${period.missingFinalTotalCount} completed job${period.missingFinalTotalCount === 1 ? "" : "s"} missing a final total`;
    case "pending_expenses":
      return `${period.pendingExpenseCount} expense${period.pendingExpenseCount === 1 ? "" : "s"} awaiting review`;
    case "unverified_historical_records":
      return `${period.omittedUnverifiedHistoricalRecordCount} unverified historical record${period.omittedUnverifiedHistoricalRecordCount === 1 ? " was" : "s were"} omitted`;
    case "unverified_expense_categories":
      return `${period.unverifiedExpenseCategoryCount} expense categor${period.unverifiedExpenseCategoryCount === 1 ? "y needs" : "ies need"} verification`;
  }
}

function OverviewCompletenessReasons({
  reasons,
  period,
}: {
  reasons: ExpenseOverviewIncompleteReason[];
  period: OverviewReasonCounts;
}) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5">
      {reasons.map((reason) => (
        <li key={reason}>{expenseOverviewReasonDetail(reason, period)}.</li>
      ))}
    </ul>
  );
}

function DumpActivityPanel({ activity }: { activity: ExpenseDumpActivity }) {
  const headingId = React.useId();
  if (
    activity.ticketCount === 0 &&
    activity.dumpFeeCents === 0 &&
    activity.weightedTicketCount === 0
  ) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} className={cardClass}>
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-300">
        Dump activity
      </p>
      <h2 id={headingId} className="mt-1 text-lg font-semibold">
        {activity.netWeightPounds > 0
          ? formatExpenseDumpWeight(activity.netWeightPounds)
          : "No confirmed weight"}
      </h2>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg border border-white/10 bg-slate-950/50 p-2.5">
          <dt className="text-slate-400">Tickets</dt>
          <dd className="mt-1 text-sm font-bold text-white">
            {activity.ticketCount}
          </dd>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/50 p-2.5">
          <dt className="text-slate-400">Dump fees</dt>
          <dd className="mt-1 text-sm font-bold text-white">
            {formatExpenseMoney(activity.dumpFeeCents)}
          </dd>
        </div>
        <div className="rounded-lg border border-white/10 bg-slate-950/50 p-2.5">
          <dt className="text-slate-400">Cost / ton</dt>
          <dd className="mt-1 text-sm font-bold text-white">
            {activity.averageCostPerTonCents === null
              ? "—"
              : formatExpenseMoney(activity.averageCostPerTonCents)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-slate-400">
        Weight recorded on {activity.weightedTicketCount} of{" "}
        {activity.ticketCount} dump expense
        {activity.ticketCount === 1 ? "" : "s"}.
      </p>
      {activity.missingWeightCount > 0 ? (
        <p
          role="status"
          className="mt-1 text-xs font-semibold leading-5 text-amber-100"
        >
          {activity.missingWeightCount} dump expense
          {activity.missingWeightCount === 1 ? " is" : "s are"} missing a
          confirmed net weight; no weight was estimated.
        </p>
      ) : null}
    </section>
  );
}

function OverviewView({
  weekStart,
  onWeekStart,
  onMissingAd,
  canEnterAdSpend,
  canManageFixedCosts,
  employeeId,
  categories,
}: {
  weekStart: string;
  onWeekStart: (date: string) => void;
  onMissingAd: (date: string) => void;
  canEnterAdSpend: boolean;
  canManageFixedCosts: boolean;
  employeeId: string;
  categories: ExpenseCategory[];
}) {
  const [overview, setOverview] = React.useState<OverviewPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [managingFixedCosts, setManagingFixedCosts] = React.useState(false);
  const [fixedCostRefresh, setFixedCostRefresh] = React.useState(0);
  const manageFixedCostsButtonRef = React.useRef<HTMLButtonElement>(null);
  const restoreManageFixedCostsFocusRef = React.useRef(false);
  React.useEffect(() => {
    if (managingFixedCosts || !restoreManageFixedCostsFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      manageFixedCostsButtonRef.current?.focus();
      restoreManageFixedCostsFocusRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [managingFixedCosts]);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(
      `/api/mobile/expenses/overview?weekStart=${encodeURIComponent(weekStart)}`,
      { cache: "no-store" },
    )
      .then(async (response) => ({
        response,
        payload: await jsonPayload(response),
      }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok)
          throw new Error(
            expenseErrorMessage(payload, "The weekly overview is unavailable."),
          );
        setOverview(expenseOverviewWithDumpDefaults(payload ?? {}));
      })
      .catch(
        (reason: unknown) =>
          active &&
          setError(
            reason instanceof Error
              ? reason.message
              : "The weekly overview is unavailable.",
          ),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [fixedCostRefresh, weekStart]);

  const firstMissingDate = overview?.missingAdEntries[0]?.businessDate ?? null;
  const headlineCards = overview
    ? [
        {
          label: "Revenue",
          value: formatExpenseMoney(overview.revenueCents),
          change: overview.priorWeekChange.revenuePercent,
          state: overview.priorWeekChange.states.revenue,
          unit: "%",
        },
        {
          label: "Expenses",
          value: formatExpenseMoney(overview.totalExpensesCents),
          change: overview.priorWeekChange.expensesPercent,
          state: overview.priorWeekChange.states.expenses,
          unit: "%",
        },
        {
          label: "Operating profit",
          value: formatExpenseMoney(overview.operatingProfitCents),
          change: overview.priorWeekChange.operatingProfitPercent,
          state: overview.priorWeekChange.states.operatingProfit,
          unit: "%",
          result:
            overview.operatingProfitCents < 0
              ? "Loss after tracked costs"
              : overview.operatingProfitCents > 0
                ? "Profit after tracked costs"
                : "Break-even after tracked costs",
          resultTone:
            overview.operatingProfitCents < 0
              ? "loss"
              : overview.operatingProfitCents > 0
                ? "profit"
                : "neutral",
        },
        {
          label: "Expense ratio",
          value: formatExpensePercent(overview.expenseRatioPercent),
          change: overview.priorWeekChange.expenseRatioPercentagePoints,
          state: overview.priorWeekChange.states.expenseRatio,
          unit: " pts",
        },
      ]
    : [];

  if (managingFixedCosts && canManageFixedCosts) {
    return (
      <MobileFixedCosts
        employeeId={employeeId}
        categories={categories}
        onBack={() => {
          restoreManageFixedCostsFocusRef.current = true;
          setManagingFixedCosts(false);
        }}
        onChanged={() => setFixedCostRefresh((value) => value + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <div className="grid grid-cols-[44px_1fr_44px] items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => onWeekStart(addDateKeyDays(weekStart, -7))}
            className={`${secondaryButton} grid place-items-center p-0`}
          >
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <label className="min-w-0 text-center">
            <span className="sr-only">Week containing date</span>
            <input
              type="date"
              value={weekStart}
              onChange={(event) =>
                onWeekStart(mondayForDateKey(event.target.value))
              }
              className={`${controlClass} text-center text-sm`}
            />
          </label>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => onWeekStart(addDateKeyDays(weekStart, 7))}
            className={`${secondaryButton} grid place-items-center p-0`}
          >
            <ChevronRight aria-hidden="true" className="size-5" />
          </button>
        </div>
        {overview ? (
          <p className="mt-2 text-center text-xs text-slate-400">
            {overview.week.startDate} through {overview.week.endDate}
          </p>
        ) : null}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {loading ? "Loading weekly overview" : ""}
      </div>
      {canManageFixedCosts ? (
        <div className={`${cardClass} flex items-center gap-3`}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Fixed costs</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              {overview
                ? `${overview.fixedCosts.activeSeriesCount} active · ${formatExpenseMoney(overview.fixedCosts.amountCents)} accrued this week`
                : "Monthly overhead, spread across each calendar day"}
            </p>
            {overview?.fixedCosts.coveredExpenseCount ? (
              <p className="mt-1 text-xs leading-5 text-cyan-100">
                {overview.fixedCosts.coveredExpenseCount} linked payment
                {overview.fixedCosts.coveredExpenseCount === 1 ? "" : "s"}
                {` totaling ${formatExpenseMoney(overview.fixedCosts.coveredExpenseAmountCents)} ${overview.fixedCosts.coveredExpenseCount === 1 ? "remains" : "remain"} in History and ${overview.fixedCosts.coveredExpenseCount === 1 ? "is" : "are"} excluded from ordinary expense totals.`}
              </p>
            ) : null}
          </div>
          <button
            ref={manageFixedCostsButtonRef}
            type="button"
            onClick={() => setManagingFixedCosts(true)}
            className={`${secondaryButton} shrink-0 px-3`}
          >
            Manage
          </button>
        </div>
      ) : null}
      {error ? <StatusNotice tone="error" message={error} /> : null}
      {overview ? (
        <>
          {overview.completeness.state === "incomplete" ? (
            <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-amber-100">
              <div className="flex gap-2">
                <CircleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0"
                />
                <div>
                  <p className="text-sm font-bold">This week is incomplete</p>
                  <OverviewCompletenessReasons
                    reasons={overview.completeness.reasons}
                    period={overview}
                  />
                </div>
              </div>
              {firstMissingDate && canEnterAdSpend ? (
                <button
                  type="button"
                  onClick={() => onMissingAd(firstMissingDate)}
                  className={`${secondaryButton} mt-3 w-full border-amber-200/30 text-amber-50`}
                >
                  Enter first missing ad day
                </button>
              ) : null}
            </div>
          ) : null}
          {!overview.priorWeekChange.available ? (
            <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
              <summary
                className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-200`}
              >
                Prior-week comparison unavailable
              </summary>
              <div className="space-y-3 border-t border-white/10 pt-3 text-slate-300">
                {overview.priorWeekChange.unavailableReasons.currentWeek
                  .length ? (
                  <div>
                    <p className="text-xs font-bold text-slate-200">
                      Selected week
                    </p>
                    <OverviewCompletenessReasons
                      reasons={
                        overview.priorWeekChange.unavailableReasons.currentWeek
                      }
                      period={overview}
                    />
                  </div>
                ) : null}
                {overview.priorWeek.completeness.reasons.length ? (
                  <div>
                    <p className="text-xs font-bold text-slate-200">
                      Prior week
                    </p>
                    <OverviewCompletenessReasons
                      reasons={overview.priorWeek.completeness.reasons}
                      period={overview.priorWeek}
                    />
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            {headlineCards.map((card) => (
              <div key={card.label} className={cardClass}>
                <p className="text-xs font-semibold text-slate-400">
                  {card.label}
                </p>
                <p className="mt-1 text-lg font-bold">{card.value}</p>
                {"result" in card && card.result ? (
                  <p
                    className={`mt-1 text-xs font-semibold ${
                      card.resultTone === "loss"
                        ? "text-rose-200"
                        : card.resultTone === "profit"
                          ? "text-emerald-200"
                          : "text-slate-300"
                    }`}
                  >
                    {card.result}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-slate-400">
                  {card.state === "incomplete"
                    ? "Comparison unavailable"
                    : card.state === "zero_baseline"
                      ? "Prior week was zero"
                      : card.state === "undefined_ratio"
                        ? "Ratio needs revenue in both weeks"
                        : card.change === null
                          ? "Comparison unavailable"
                          : `${card.change >= 0 ? "+" : ""}${card.change.toFixed(1)}${card.unit} vs prior`}
                </p>
              </div>
            ))}
          </div>
          <MobileExpenseDonut
            categories={overview.categories}
            totalExpensesCents={overview.totalExpensesCents}
          />
          <DumpActivityPanel activity={overview.dumpActivity} />
          <details className={cardClass}>
            <summary
              className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100`}
            >
              Labor and advertising detail
            </summary>
            <div className="mt-3 space-y-3 border-t border-white/10 pt-3 text-sm">
              <div className="flex justify-between">
                <span>
                  Labor (
                  {overview.labor.state === "actual" ? "Actual" : "Estimated"})
                </span>
                <strong>
                  {formatExpenseMoney(overview.labor.amountCents)}
                </strong>
              </div>
              <div className="space-y-1 pl-3 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Crew</span>
                  <span>
                    {formatExpenseMoney(overview.labor.subrows.crewCents)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Sales</span>
                  <span>
                    {formatExpenseMoney(overview.labor.subrows.salesCents)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Management</span>
                  <span>
                    {formatExpenseMoney(overview.labor.subrows.managementCents)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Other payroll</span>
                  <span>
                    {formatExpenseMoney(
                      overview.labor.subrows.otherPayrollAdjustmentsCents,
                    )}
                  </span>
                </div>
              </div>
              <div className="flex justify-between border-t border-white/10 pt-3">
                <span>Advertising</span>
                <strong>
                  {formatExpenseMoney(overview.advertising.amountCents)}
                </strong>
              </div>
              <div className="space-y-1 pl-3 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Facebook</span>
                  <span>
                    {formatExpenseMoney(
                      overview.advertising.subrows.facebookCents,
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Google</span>
                  <span>
                    {formatExpenseMoney(
                      overview.advertising.subrows.googleCents,
                    )}
                  </span>
                </div>
                {overview.advertising.unattributedCents ? (
                  <div className="flex justify-between">
                    <span>Other advertising</span>
                    <span>
                      {formatExpenseMoney(
                        overview.advertising.unattributedCents,
                      )}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </details>
        </>
      ) : loading ? (
        <div className={`${cardClass} text-sm text-slate-300`}>
          Loading this week…
        </div>
      ) : null}
    </div>
  );
}

const historyFilters = [
  ["all", "All entries"],
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["dump_tickets", "Dump expenses"],
  ["reimbursement", "Reimbursements"],
] as const;

async function fetchExactDuplicateReviewPage(cursor: string | null): Promise<{
  captures: ExactDuplicateReviewItem[];
  page: { hasMore: boolean; nextCursor: string | null };
}> {
  const search = new URLSearchParams({ limit: "20" });
  if (cursor) search.set("cursor", cursor);
  const response = await fetch(
    `/api/mobile/expenses/captures?${search.toString()}`,
    { cache: "no-store", credentials: "include" },
  );
  const payload = await jsonPayload(response);
  if (!response.ok) {
    throw new Error(
      expenseErrorMessage(payload, "Duplicate receipts are unavailable."),
    );
  }
  const page = objectValue(payload?.["page"]);
  return {
    captures: Array.isArray(payload?.["captures"])
      ? (payload["captures"] as ExactDuplicateReviewItem[])
      : [],
    page: {
      hasMore: page?.["hasMore"] === true,
      nextCursor:
        typeof page?.["nextCursor"] === "string" ? page["nextCursor"] : null,
    },
  };
}

async function fetchExpenseHistoryPage(
  filter: string,
  cursor: string | null,
): Promise<{
  expenses: ExpenseHistoryRow[];
  page: { hasMore: boolean; nextCursor: string | null };
}> {
  const search = new URLSearchParams({ filter, limit: "40" });
  if (cursor) search.set("cursor", cursor);
  const response = await fetch(
    `/api/mobile/expenses/submissions?${search.toString()}`,
    { cache: "no-store", credentials: "include" },
  );
  const payload = await jsonPayload(response);
  if (!response.ok) {
    throw new Error(
      expenseErrorMessage(payload, "Expense history is unavailable."),
    );
  }
  const page = objectValue(payload?.["page"]);
  return {
    expenses: Array.isArray(payload?.["expenses"])
      ? payload["expenses"].flatMap((value) => {
          const row = objectValue(value);
          return row
            ? [
                {
                  ...(row as unknown as ExpenseHistoryRow),
                  dumpDetails: expenseHistoryDumpDetailsValue(
                    row["dumpDetails"],
                  ),
                  reversalOfExpenseId:
                    typeof row["reversalOfExpenseId"] === "string"
                      ? row["reversalOfExpenseId"]
                      : null,
                  correctionOfExpenseId:
                    typeof row["correctionOfExpenseId"] === "string"
                      ? row["correctionOfExpenseId"]
                      : null,
                  correctedByExpenseId:
                    typeof row["correctedByExpenseId"] === "string"
                      ? row["correctedByExpenseId"]
                      : null,
                },
              ]
            : [];
        })
      : [],
    page: {
      hasMore: page?.["hasMore"] === true,
      nextCursor:
        typeof page?.["nextCursor"] === "string" ? page["nextCursor"] : null,
    },
  };
}

function exactDuplicateReceiptHref(captureId: string): string {
  return `/api/mobile/expenses/captures/${encodeURIComponent(captureId)}/content`;
}

function expenseHistoryReceiptHref(
  row: Pick<ExpenseHistoryRow, "id" | "receipt">,
): string | null {
  if (!row.receipt) return null;
  return row.receipt.captureId
    ? `/api/mobile/expenses/captures/${encodeURIComponent(row.receipt.captureId)}/content`
    : `/api/mobile/expenses/${encodeURIComponent(row.id)}/receipt`;
}

function ExactDuplicateQueueCard({
  item,
  categories,
  onReview,
}: {
  item: ExactDuplicateReviewItem;
  categories: ExpenseCategory[];
  onReview: () => void;
}) {
  const extracted = receiptExtractionFromCapture(item.capture);
  const category = categories.find(
    (candidate) => candidate.id === extracted.initial?.categoryId,
  );
  return (
    <article className="rounded-xl border border-rose-300/25 bg-rose-300/[0.06] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-rose-200">
            Exact receipt match
          </p>
          <p className="mt-1 truncate text-sm font-semibold text-white">
            {extracted.initial?.vendor || "Vendor needs review"}
          </p>
          <p className="mt-0.5 text-xs text-slate-300">
            Submitted by {item.submitter.name}
          </p>
        </div>
        <p className="shrink-0 text-base font-bold">
          {extracted.initial?.amount
            ? `$${extracted.initial.amount}`
            : "Check total"}
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">Receipt date</dt>
          <dd className="mt-0.5 text-slate-200">
            {extracted.initial?.purchaseDate || "Check this"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Suggested category</dt>
          <dd className="mt-0.5 truncate text-slate-200">
            {category?.name || "Check this"}
          </dd>
        </div>
      </dl>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a
          href={exactDuplicateReceiptHref(item.capture.id)}
          target="_blank"
          rel="noreferrer"
          className={`${secondaryButton} flex items-center justify-center text-center`}
        >
          Current receipt
        </a>
        {item.duplicate?.capture.contentPath ? (
          <a
            href={exactDuplicateReceiptHref(item.duplicate.capture.id)}
            target="_blank"
            rel="noreferrer"
            className={`${secondaryButton} flex items-center justify-center text-center`}
          >
            Matched receipt
          </a>
        ) : (
          <span className="flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-2 text-center text-xs text-slate-500">
            Match unavailable
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onReview}
        className={`${secondaryButton} mt-3 w-full`}
      >
        Review duplicate
      </button>
    </article>
  );
}

function HistoryView({
  employeeId,
  currentMember,
  memberOptions,
  categories,
  jobs,
  canSubmit,
  canApprove,
  allowReimbursement,
  exactDuplicateReviewEnabled,
  fixedCostCoverageEnabled,
  dumpTicketsEnabled,
  refreshToken,
}: {
  employeeId: string;
  currentMember: MemberOption;
  memberOptions: MemberOption[];
  categories: ExpenseCategory[];
  jobs: JobOption[];
  canSubmit: boolean;
  canApprove: boolean;
  allowReimbursement: boolean;
  exactDuplicateReviewEnabled: boolean;
  fixedCostCoverageEnabled: boolean;
  dumpTicketsEnabled: boolean;
  refreshToken: number;
}) {
  const [filter, setFilter] = React.useState("all");
  const [rows, setRows] = React.useState<ExpenseHistoryRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [historyCursor, setHistoryCursor] = React.useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = React.useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<ExpenseHistoryRow | null>(
    null,
  );
  const [reason, setReason] = React.useState("");
  const [reviewCategoryId, setReviewCategoryId] = React.useState("");
  const [reviewDumpDetails, setReviewDumpDetails] = React.useState(
    emptyExpenseDumpDetailsDraft(),
  );
  const [reviewNotScaleTicket, setReviewNotScaleTicket] = React.useState(false);
  const [
    reviewCoveredByFixedCostSeriesId,
    setReviewCoveredByFixedCostSeriesId,
  ] = React.useState("");
  const [lockVendorRule, setLockVendorRule] = React.useState(false);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const [correctingDump, setCorrectingDump] =
    React.useState<ExpenseHistoryRow | null>(null);
  const [correctionDumpDetails, setCorrectionDumpDetails] = React.useState(
    emptyExpenseDumpDetailsDraft(),
  );
  const [correctionRemoveDumpDetails, setCorrectionRemoveDumpDetails] =
    React.useState(false);
  const [correctionReason, setCorrectionReason] = React.useState("");
  const [correctionBusy, setCorrectionBusy] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [duplicateRows, setDuplicateRows] = React.useState<
    ExactDuplicateReviewItem[]
  >([]);
  const [duplicateCursor, setDuplicateCursor] = React.useState<string | null>(
    null,
  );
  const [duplicateHasMore, setDuplicateHasMore] = React.useState(false);
  const [duplicateLoading, setDuplicateLoading] = React.useState(false);
  const [duplicateError, setDuplicateError] = React.useState<string | null>(
    null,
  );
  const [reviewingDuplicate, setReviewingDuplicate] =
    React.useState<ExactDuplicateReviewItem | null>(null);
  const [duplicateBusy, setDuplicateBusy] = React.useState(false);
  const [duplicateReload, setDuplicateReload] = React.useState(0);
  const [success, setSuccess] = React.useState<string | null>(null);
  const visibleHistoryFilters = dumpTicketsEnabled
    ? historyFilters
    : historyFilters.filter(([value]) => value !== "dump_tickets");

  React.useEffect(() => {
    if (!dumpTicketsEnabled && filter === "dump_tickets") setFilter("all");
  }, [dumpTicketsEnabled, filter]);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setHistoryCursor(null);
    setHistoryHasMore(false);
    void fetchExpenseHistoryPage(filter, null)
      .then((result) => {
        if (!active) return;
        setRows(result.expenses);
        setHistoryCursor(result.page.nextCursor);
        setHistoryHasMore(result.page.hasMore);
      })
      .catch(
        (reasonValue: unknown) =>
          active &&
          setError(
            reasonValue instanceof Error
              ? reasonValue.message
              : "Expense history is unavailable.",
          ),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [filter, refreshToken, reload]);

  React.useEffect(() => {
    if (!exactDuplicateReviewEnabled) {
      setDuplicateRows([]);
      setDuplicateCursor(null);
      setDuplicateHasMore(false);
      setReviewingDuplicate(null);
      return;
    }
    let active = true;
    setDuplicateLoading(true);
    setDuplicateError(null);
    void fetchExactDuplicateReviewPage(null)
      .then((result) => {
        if (!active) return;
        setDuplicateRows(result.captures);
        setDuplicateCursor(result.page.nextCursor);
        setDuplicateHasMore(result.page.hasMore);
      })
      .catch(
        (reasonValue: unknown) =>
          active &&
          setDuplicateError(
            reasonValue instanceof Error
              ? reasonValue.message
              : "Duplicate receipts are unavailable.",
          ),
      )
      .finally(() => active && setDuplicateLoading(false));
    return () => {
      active = false;
    };
  }, [duplicateReload, exactDuplicateReviewEnabled, refreshToken]);

  const review = async (decision: "approve" | "reject") => {
    if (!reviewing) return;
    if (decision === "reject" && reason.trim().length < 3) {
      setError("Add a short rejection reason.");
      return;
    }
    if (decision === "approve" && !reviewCategoryId) {
      setError("Choose a category before approving this expense.");
      return;
    }
    const reviewShowsDumpDetails = Boolean(
      dumpTicketsEnabled &&
        !reviewNotScaleTicket &&
        (reviewing.dumpDetails ||
          reviewCategoryId === "dump_fees" ||
          reviewing.allocations.some(
            (allocation) => allocation.categoryId === "dump_fees",
          )),
    );
    const parsedDumpDetails =
      decision === "approve" && reviewShowsDumpDetails
        ? buildExpenseDumpSubmissionDetails(reviewDumpDetails, {
            required: Boolean(reviewing.dumpDetails),
          })
        : ({ ok: true, details: null } as const);
    if (!parsedDumpDetails.ok) {
      setError(parsedDumpDetails.message);
      return;
    }
    setReviewBusy(true);
    setError(null);
    try {
      const categoryChanged =
        decision === "approve" && reviewCategoryId !== reviewing.categoryId;
      const requestBody = {
        decision,
        reason: reason.trim() || null,
        ...(categoryChanged ? { categoryId: reviewCategoryId } : {}),
        ...(decision === "approve"
          ? {
              coveredByFixedCostSeriesId:
                reviewCoveredByFixedCostSeriesId || null,
            }
          : {}),
        ...(decision === "approve" && lockVendorRule
          ? { lockVendorRule: true }
          : {}),
        ...(decision === "approve" && parsedDumpDetails.details
          ? { dumpDetails: parsedDumpDetails.details }
          : {}),
        ...(decision === "approve" && reviewNotScaleTicket
          ? { scaleTicketDisposition: "not_scale_ticket" as const }
          : {}),
      };
      const attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: `expense-review:${reviewing.id}`,
        payload: { version: reviewing.version, body: requestBody },
      });
      const response = await fetch(
        `/api/mobile/expenses/submissions/${encodeURIComponent(reviewing.id)}/review`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKey,
            "If-Match": String(reviewing.version),
          },
          body: JSON.stringify(requestBody),
        },
      );
      const payload = await jsonPayload(response);
      if (!response.ok) {
        setError(expenseErrorMessage(payload, "The review was not saved."));
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      setReviewing(null);
      setReason("");
      setReviewCategoryId("");
      setReviewDumpDetails(emptyExpenseDumpDetailsDraft());
      setReviewNotScaleTicket(false);
      setReviewCoveredByFixedCostSeriesId("");
      setLockVendorRule(false);
      setReload((value) => value + 1);
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error &&
          reasonValue.message.startsWith("Secure expense retry storage")
          ? reasonValue.message
          : "The connection was interrupted. Retry the same review safely.",
      );
    } finally {
      setReviewBusy(false);
    }
  };

  const loadMoreHistory = async (): Promise<void> => {
    if (!historyCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setError(null);
    try {
      const result = await fetchExpenseHistoryPage(filter, historyCursor);
      setRows((current) => {
        const known = new Set(current.map((row) => row.id));
        return [
          ...current,
          ...result.expenses.filter((row) => !known.has(row.id)),
        ];
      });
      setHistoryCursor(result.page.nextCursor);
      setHistoryHasMore(result.page.hasMore);
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : "More expense history could not be loaded.",
      );
    } finally {
      setHistoryLoadingMore(false);
    }
  };

  const correctDumpWeight = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const row = correctingDump;
    if (!row) return;
    const correction = buildExpenseDumpCorrectionBody(
      row,
      correctionDumpDetails,
      correctionReason,
      correctionRemoveDumpDetails,
    );
    if (!correction.ok) {
      setError(correction.message);
      return;
    }
    setCorrectionBusy(true);
    setError(null);
    setSuccess(null);
    let attempt: ExpenseMutationAttempt | null = null;
    try {
      attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: `expense-dump-correct:${row.id}`,
        payload: { version: row.version, body: correction.body },
      });
      const response = await fetch(
        `/api/mobile/expenses/${encodeURIComponent(row.id)}/correct`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKey,
            "If-Match": String(row.version),
          },
          body: JSON.stringify(correction.body),
        },
      );
      const payload = await jsonPayload(response);
      if (!response.ok) {
        setError(
          expenseErrorMessage(
            payload,
            "The reviewed dump weight was not saved.",
          ),
        );
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      setCorrectingDump(null);
      setCorrectionDumpDetails(emptyExpenseDumpDetailsDraft());
      setCorrectionRemoveDumpDetails(false);
      setCorrectionReason("");
      setSuccess(
        correctionRemoveDumpDetails
          ? "Scale-ticket details removed with a linked correction. The original expense remains in History."
          : "Reviewed dump weight saved with a linked correction. The original expense remains in History.",
      );
      setReload((value) => value + 1);
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error &&
          reasonValue.message.startsWith("Secure expense retry storage")
          ? reasonValue.message
          : "The response was interrupted. Retry the same reviewed weight safely; the original remains unchanged until the server confirms it.",
      );
    } finally {
      setCorrectionBusy(false);
    }
  };

  const finishDuplicateReview = (captureId: string, message: string): void => {
    setDuplicateRows((current) =>
      current.filter((item) => item.capture.id !== captureId),
    );
    setReviewingDuplicate(null);
    setDuplicateError(null);
    setSuccess(message);
    setDuplicateReload((value) => value + 1);
    setReload((value) => value + 1);
  };

  const reconcileDuplicateCapture = async (
    item: ExactDuplicateReviewItem,
    attempt: ExpenseMutationAttempt | null,
  ): Promise<boolean> => {
    const response = await fetch(
      `/api/mobile/expenses/captures/${encodeURIComponent(item.capture.id)}`,
      { cache: "no-store", credentials: "include" },
    ).catch(() => null);
    if (!response?.ok) return false;
    const payload = await jsonPayload(response);
    const capture = objectValue(payload?.["capture"]);
    const status = capture?.["status"];
    if (status === "confirmed") {
      if (attempt) {
        await acknowledgeExpenseMutationAttempt(attempt).catch(() => undefined);
      }
      finishDuplicateReview(
        item.capture.id,
        "The duplicate receipt was already confirmed.",
      );
      return true;
    }
    if (status === "discarded") {
      finishDuplicateReview(item.capture.id, "The receipt was discarded.");
      return true;
    }
    if (
      capture &&
      typeof capture["id"] === "string" &&
      typeof capture["version"] === "number"
    ) {
      const nextItem = {
        ...item,
        capture: capture as ExpenseCaptureStatus,
      };
      setReviewingDuplicate(nextItem);
      setDuplicateRows((current) =>
        current.map((candidate) =>
          candidate.capture.id === item.capture.id ? nextItem : candidate,
        ),
      );
    }
    return false;
  };

  const confirmDuplicate = async (
    body: SubmissionBody,
    overrideReason: string | null,
    scaleTicketDisposition: ScaleTicketDisposition,
  ): Promise<void> => {
    const item = reviewingDuplicate;
    if (!item) return;
    if (!canSubmit) {
      setDuplicateError(
        "This owner can review duplicates but cannot post expenses. Ask an owner with expense submission access to finish it.",
      );
      return;
    }
    const requestBody = {
      ...body,
      ...(dumpTicketsEnabled ? { receiptReviewContractVersion: 2 } : {}),
      ...(overrideReason
        ? { exactDuplicateOverrideReason: overrideReason }
        : {}),
      ...(scaleTicketDisposition ? { scaleTicketDisposition } : {}),
    };
    let attempt: ExpenseMutationAttempt | null = null;
    setDuplicateBusy(true);
    setDuplicateError(null);
    setSuccess(null);
    try {
      attempt = await getExpenseMutationAttempt({
        employeeId,
        operation: `owner-duplicate-confirm:${item.capture.id}`,
        payload: { version: item.capture.version, body: requestBody },
      });
      const response = await fetch(
        `/api/mobile/expenses/captures/${encodeURIComponent(item.capture.id)}/confirm`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKey,
            "If-Match": String(item.capture.version),
          },
          body: JSON.stringify(requestBody),
        },
      );
      const payload = await jsonPayload(response);
      if (!response.ok) {
        if (
          (response.status === 409 || response.status === 412) &&
          (await reconcileDuplicateCapture(item, attempt))
        ) {
          return;
        }
        setDuplicateError(
          expenseErrorMessage(
            payload,
            "The duplicate receipt was not confirmed.",
          ),
        );
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      finishDuplicateReview(item.capture.id, "Duplicate expense posted.");
    } catch (reasonValue) {
      if (await reconcileDuplicateCapture(item, attempt)) return;
      setDuplicateError(
        reasonValue instanceof Error &&
          reasonValue.message.startsWith("Secure expense retry storage")
          ? reasonValue.message
          : "The response was interrupted. The same confirmation is ready to retry safely.",
      );
    } finally {
      setDuplicateBusy(false);
    }
  };

  const discardDuplicate = async (): Promise<void> => {
    const item = reviewingDuplicate;
    if (!item) return;
    setDuplicateBusy(true);
    setDuplicateError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `/api/mobile/expenses/captures/${encodeURIComponent(item.capture.id)}`,
        { method: "DELETE", credentials: "include" },
      );
      const payload = await jsonPayload(response);
      if (!response.ok) {
        if (await reconcileDuplicateCapture(item, null)) return;
        setDuplicateError(
          expenseErrorMessage(
            payload,
            "The receipt was not discarded and remains in the review queue.",
          ),
        );
        return;
      }
      finishDuplicateReview(item.capture.id, "Duplicate receipt discarded.");
    } catch {
      if (await reconcileDuplicateCapture(item, null)) return;
      setDuplicateError(
        "The discard response was interrupted. The receipt remains in the queue until the server confirms it.",
      );
    } finally {
      setDuplicateBusy(false);
    }
  };

  const loadMoreDuplicates = async (): Promise<void> => {
    if (!duplicateCursor || duplicateLoading) return;
    setDuplicateLoading(true);
    setDuplicateError(null);
    try {
      const result = await fetchExactDuplicateReviewPage(duplicateCursor);
      setDuplicateRows((current) => {
        const knownIds = new Set(current.map((item) => item.capture.id));
        return [
          ...current,
          ...result.captures.filter((item) => !knownIds.has(item.capture.id)),
        ];
      });
      setDuplicateCursor(result.page.nextCursor);
      setDuplicateHasMore(result.page.hasMore);
    } catch (reasonValue) {
      setDuplicateError(
        reasonValue instanceof Error
          ? reasonValue.message
          : "More duplicate receipts could not be loaded.",
      );
    } finally {
      setDuplicateLoading(false);
    }
  };

  if (reviewingDuplicate) {
    const extracted = receiptExtractionFromCapture(reviewingDuplicate.capture);
    const duplicate = reviewingDuplicate.duplicate;
    return (
      <div className={`${cardClass} space-y-4`}>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-200">
            Exact duplicate review
          </p>
          <h2 className="mt-1 text-lg font-semibold">Confirm before posting</h2>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            Submitted by {reviewingDuplicate.submitter.name}. Compare both
            originals and record why this should be posted again.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <a
            href={exactDuplicateReceiptHref(reviewingDuplicate.capture.id)}
            target="_blank"
            rel="noreferrer"
            className={`${secondaryButton} flex items-center justify-center text-center`}
          >
            Current receipt
          </a>
          {duplicate?.capture.contentPath ? (
            <a
              href={exactDuplicateReceiptHref(duplicate.capture.id)}
              target="_blank"
              rel="noreferrer"
              className={`${secondaryButton} flex items-center justify-center text-center`}
            >
              Matched receipt
            </a>
          ) : (
            <span className="flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-2 text-center text-xs text-slate-500">
              Matched receipt unavailable
            </span>
          )}
        </div>
        <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <summary
            className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-200`}
          >
            Matched entry details
          </summary>
          <dl className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-xs">
            <div>
              <dt className="text-slate-500">Original submitter</dt>
              <dd className="mt-1 text-slate-200">
                {duplicate?.capture.submitterName ?? "Unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Original filename</dt>
              <dd className="mt-1 break-words text-slate-200">
                {duplicate?.capture.filename ?? "Unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Posted amount</dt>
              <dd className="mt-1 text-slate-200">
                {duplicate?.expense
                  ? formatExpenseMoney(duplicate.expense.amountCents)
                  : "No posted expense"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Vendor / category</dt>
              <dd className="mt-1 text-slate-200">
                {duplicate?.expense
                  ? [duplicate.expense.vendor, duplicate.expense.category]
                      .filter(Boolean)
                      .join(" · ") || "Not recorded"
                  : "Not recorded"}
              </dd>
            </div>
          </dl>
        </details>
        {!canSubmit ? (
          <StatusNotice
            tone="error"
            message="Your role can review duplicates but cannot post expenses. Another owner with expense submission access must confirm this receipt."
          />
        ) : null}
        {duplicateError ? (
          <StatusNotice tone="error" message={duplicateError} />
        ) : null}
        <ExpenseEditor
          key={`${reviewingDuplicate.capture.id}:${reviewingDuplicate.capture.version}`}
          categories={categories}
          currentMember={currentMember}
          memberOptions={memberOptions}
          jobs={jobs}
          canApprove={canApprove}
          allowReimbursement={allowReimbursement}
          fixedCostCoverageEnabled={fixedCostCoverageEnabled}
          dumpTicketsEnabled={dumpTicketsEnabled}
          initial={extracted.initial}
          attentionFields={extracted.attention}
          vendorPrimary
          duplicateRisk="exact"
          submitting={duplicateBusy}
          submitDisabled={!canSubmit}
          submitLabel="Post expense"
          onBack={() => {
            setReviewingDuplicate(null);
            setDuplicateError(null);
          }}
          onSubmit={confirmDuplicate}
        />
        <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <summary
            className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-300`}
          >
            Receipt actions
          </summary>
          <button
            type="button"
            disabled={duplicateBusy}
            onClick={() => void discardDuplicate()}
            className={`${secondaryButton} mt-3 w-full border-rose-300/30 text-rose-100`}
          >
            Discard duplicate receipt
          </button>
        </details>
      </div>
    );
  }

  if (correctingDump) {
    const receiptHref = expenseHistoryReceiptHref(correctingDump);
    return (
      <form
        onSubmit={(event) => void correctDumpWeight(event)}
        className={`${cardClass} space-y-4`}
      >
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
            Dump expense correction
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            {correctingDump.dumpDetails
              ? "Correct dump weight"
              : "Add dump weight"}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-300">
            {formatExpenseMoney(correctingDump.amountCents)} ·{" "}
            {correctingDump.category} · {correctingDump.purchaseDate}. This
            creates a linked replacement and keeps the original in History.
          </p>
        </div>
        {receiptHref ? (
          <a
            href={receiptHref}
            target="_blank"
            rel="noreferrer"
            className={`${secondaryButton} flex w-full items-center justify-center gap-2`}
          >
            <FileText aria-hidden="true" className="size-4" />
            View receipt
          </a>
        ) : null}
        {correctingDump.dumpDetails ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
            <label className="flex min-h-11 items-center gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={correctionRemoveDumpDetails}
                onChange={(event) =>
                  setCorrectionRemoveDumpDetails(event.target.checked)
                }
                className={`${focusRing} size-5 rounded border-white/20 bg-slate-950`}
              />
              <span>Remove scale-ticket details</span>
            </label>
            {correctionRemoveDumpDetails ? (
              <p className="mt-2 text-xs font-semibold text-amber-100">
                The active corrected entry will keep the expense amount and
                receipt, but no longer count as a weighed load.
              </p>
            ) : null}
          </div>
        ) : null}
        {!correctionRemoveDumpDetails ? (
          <DumpTicketFields
            draft={correctionDumpDetails}
            onChange={setCorrectionDumpDetails}
            required
            attentionFields={[]}
          />
        ) : null}
        <label className="block">
          <FieldLabel>Correction reason</FieldLabel>
          <textarea
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
            minLength={3}
            maxLength={500}
            rows={3}
            required
            className={controlClass}
            placeholder="What was corrected?"
          />
        </label>
        {error ? <StatusNotice tone="error" message={error} /> : null}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {correctionBusy
            ? correctionRemoveDumpDetails
              ? "Removing scale-ticket details"
              : "Saving reviewed dump weight"
            : ""}
        </div>
        <button
          type="submit"
          disabled={correctionBusy}
          className={primaryButton}
        >
          {correctionBusy
            ? "Saving…"
            : correctionRemoveDumpDetails
              ? "Save classification correction"
              : "Save reviewed weight"}
        </button>
        <button
          type="button"
          disabled={correctionBusy}
          onClick={() => {
            setCorrectingDump(null);
            setCorrectionDumpDetails(emptyExpenseDumpDetailsDraft());
            setCorrectionRemoveDumpDetails(false);
            setCorrectionReason("");
            setError(null);
          }}
          className={`${secondaryButton} w-full`}
        >
          Back
        </button>
      </form>
    );
  }

  if (reviewing) {
    const linkedJob = reviewing.appointmentId
      ? (jobs.find((job) => job.id === reviewing.appointmentId) ?? null)
      : null;
    const reviewShowsDumpDetails = Boolean(
      dumpTicketsEnabled &&
        !reviewNotScaleTicket &&
        (reviewing.dumpDetails ||
          reviewCategoryId === "dump_fees" ||
          reviewing.allocations.some(
            (allocation) => allocation.categoryId === "dump_fees",
          )),
    );
    return (
      <div className={`${cardClass} space-y-4`}>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
            Review expense
          </p>
          <h2 className="mt-1 text-lg font-semibold">
            {formatExpenseMoney(reviewing.amountCents)} · {reviewing.category}
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            Submitted by {reviewing.submitter?.name ?? "Unknown"} for{" "}
            {reviewing.purchaseDate}.
          </p>
          {reviewing.dumpDetails ? (
            <p className="mt-1 text-sm font-semibold text-cyan-100">
              {reviewing.dumpDetails.weightStatus === "confirmed" &&
              reviewing.dumpDetails.netWeightPounds
                ? formatExpenseDumpWeight(reviewing.dumpDetails.netWeightPounds)
                : "Net weight unreadable"}
              {reviewing.dumpDetails.material
                ? ` · ${reviewing.dumpDetails.material}`
                : ""}
            </p>
          ) : null}
        </div>
        {reviewing.receipt ? (
          <a
            href={
              reviewing.receipt.captureId
                ? `/api/mobile/expenses/captures/${encodeURIComponent(reviewing.receipt.captureId)}/content`
                : `/api/mobile/expenses/${encodeURIComponent(reviewing.id)}/receipt`
            }
            target="_blank"
            rel="noreferrer"
            className={`${secondaryButton} flex w-full items-center justify-center`}
          >
            View receipt
          </a>
        ) : null}
        <label className="block">
          <FieldLabel>Category</FieldLabel>
          <select
            value={reviewCategoryId}
            onChange={(event) => setReviewCategoryId(event.target.value)}
            className={controlClass}
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {reviewCategoryId !== reviewing.categoryId ? (
            <p className="mt-1 text-xs text-amber-200">
              Approval will replace the current category allocation with this
              category.
            </p>
          ) : null}
        </label>
        {dumpTicketsEnabled && reviewing.dumpDetails ? (
          <div className="rounded-xl border border-cyan-300/25 bg-cyan-300/[0.06] p-3">
            <p className="text-sm font-semibold text-cyan-100">
              Scale-ticket classification
            </p>
            <label className="mt-2 flex min-h-11 items-center gap-3 rounded-lg border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={reviewNotScaleTicket}
                onChange={(event) =>
                  setReviewNotScaleTicket(event.target.checked)
                }
                className={`${focusRing} size-5 rounded border-white/20 bg-slate-950`}
              />
              <span>This is not a scale ticket</span>
            </label>
            {reviewNotScaleTicket ? (
              <p className="mt-2 text-xs font-semibold text-amber-100">
                Approval will remove the draft weight details. Review the
                category before approving.
              </p>
            ) : null}
          </div>
        ) : null}
        {reviewShowsDumpDetails ? (
          <DumpTicketFields
            draft={reviewDumpDetails}
            onChange={setReviewDumpDetails}
            required={Boolean(reviewing.dumpDetails)}
            attentionFields={[]}
          />
        ) : null}
        <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <summary
            className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-200`}
          >
            Expense details
          </summary>
          <dl className="grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-xs">
            <div>
              <dt className="text-slate-500">Vendor</dt>
              <dd className="mt-1 break-words text-slate-200">
                {reviewing.vendor ?? "Not provided"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Payer</dt>
              <dd className="mt-1 text-slate-200">
                {reviewing.payerType === "personal"
                  ? (reviewing.paidByMember?.name ?? "Employee-paid")
                  : "Company"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Payment method</dt>
              <dd className="mt-1 capitalize text-slate-200">
                {reviewing.method ?? "Not provided"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Job</dt>
              <dd className="mt-1 break-words text-slate-200">
                {linkedJob
                  ? `${linkedJob.date} · ${linkedJob.label}`
                  : reviewing.appointmentId
                    ? `Job ${reviewing.appointmentId}`
                    : "Not linked"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-500">Notes</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-slate-200">
                {reviewing.notes ?? "None"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-500">Category allocation</dt>
              <dd className="mt-1 space-y-1 text-slate-200">
                {reviewing.allocations?.length ? (
                  reviewing.allocations.map((allocation) => (
                    <span
                      key={allocation.categoryId}
                      className="flex justify-between gap-3"
                    >
                      <span>{allocation.category}</span>
                      <span>{formatExpenseMoney(allocation.amountCents)}</span>
                    </span>
                  ))
                ) : (
                  <span className="flex justify-between gap-3">
                    <span>{reviewing.category}</span>
                    <span>{formatExpenseMoney(reviewing.amountCents)}</span>
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </details>
        <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <summary
            className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-200`}
          >
            Approval preferences
          </summary>
          <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
            <FixedCostCoverageField
              enabled={fixedCostCoverageEnabled}
              purchaseDate={reviewing.purchaseDate}
              amountCents={reviewing.amountCents}
              categoryId={reviewCategoryId}
              splitEnabled={
                reviewing.allocations.length > 1 &&
                reviewCategoryId === reviewing.categoryId
              }
              value={reviewCoveredByFixedCostSeriesId}
              onChange={setReviewCoveredByFixedCostSeriesId}
            />
            <label className="flex min-h-11 items-center gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={lockVendorRule}
                disabled={!reviewing.vendor}
                onChange={(event) => setLockVendorRule(event.target.checked)}
                className={`${focusRing} size-5 rounded border-white/20 bg-slate-950`}
              />
              <span>
                Remember this category for {reviewing.vendor ?? "this vendor"}
              </span>
            </label>
          </div>
          {!reviewing.vendor ? (
            <p className="mt-1 text-xs text-slate-500">
              A vendor name is required before a category can be remembered.
            </p>
          ) : null}
        </details>
        <label className="block">
          <FieldLabel>
            Review note (required to reject or approve a matching ticket)
          </FieldLabel>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            className={controlClass}
            placeholder="Explain a rejection or why a matching ticket is valid"
          />
        </label>
        {error ? <StatusNotice tone="error" message={error} /> : null}
        <button
          type="button"
          disabled={reviewBusy}
          onClick={() => void review("approve")}
          className={primaryButton}
        >
          {reviewBusy ? "Working…" : "Approve expense"}
        </button>
        <button
          type="button"
          disabled={reviewBusy}
          onClick={() => void review("reject")}
          className={`${secondaryButton} w-full border-rose-300/30 text-rose-100`}
        >
          Reject expense
        </button>
        <button
          type="button"
          disabled={reviewBusy}
          onClick={() => {
            setReviewing(null);
            setReason("");
            setReviewCategoryId("");
            setReviewDumpDetails(emptyExpenseDumpDetailsDraft());
            setReviewNotScaleTicket(false);
            setReviewCoveredByFixedCostSeriesId("");
            setLockVendorRule(false);
            setError(null);
          }}
          className={`${secondaryButton} w-full`}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {success ? <StatusNotice tone="success" message={success} /> : null}
      {duplicateError ? (
        <StatusNotice tone="error" message={duplicateError} />
      ) : null}
      {exactDuplicateReviewEnabled &&
      (duplicateLoading || duplicateRows.length > 0) ? (
        <section
          aria-labelledby="duplicate-review-heading"
          className="space-y-3"
        >
          <div className={cardClass}>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-200">
              Owner review
            </p>
            <h2 id="duplicate-review-heading" className="mt-1 font-semibold">
              Exact duplicate receipts
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Compare both originals before posting or discarding.
            </p>
          </div>
          {duplicateRows.map((item) => (
            <ExactDuplicateQueueCard
              key={item.capture.id}
              item={item}
              categories={categories}
              onReview={() => {
                setReviewingDuplicate(item);
                setDuplicateError(null);
                setSuccess(null);
              }}
            />
          ))}
          {duplicateLoading && !duplicateRows.length ? (
            <div className={`${cardClass} text-sm text-slate-300`}>
              Checking exact duplicate receipts…
            </div>
          ) : null}
          {duplicateHasMore ? (
            <button
              type="button"
              disabled={duplicateLoading}
              onClick={() => void loadMoreDuplicates()}
              className={`${secondaryButton} w-full`}
            >
              {duplicateLoading ? "Loading…" : "Load more duplicates"}
            </button>
          ) : null}
        </section>
      ) : null}
      <div className={cardClass}>
        <label className="block">
          <FieldLabel>Filter history</FieldLabel>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className={controlClass}
          >
            {visibleHistoryFilters.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {loading
          ? "Loading expense history"
          : `${rows.length} expense entries loaded`}
      </div>
      {error ? <StatusNotice tone="error" message={error} /> : null}
      {rows.map((row) => {
        const displayStatus = expenseHistoryDisplayStatus(
          row.lifecycleStatus,
          row.reviewStatus,
        );
        const canCorrectDumpWeight = expenseHistoryCanCorrectDumpWeight(
          row,
          canApprove && dumpTicketsEnabled,
        );
        const correctionLabel = expenseHistoryCorrectionLabel(row);
        return (
          <article key={row.id} className={cardClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-bold">
                  {formatExpenseMoney(row.amountCents)}
                </p>
                <p className="mt-0.5 truncate text-sm font-semibold text-slate-200">
                  {row.category}
                  {row.vendor ? ` · ${row.vendor}` : ""}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-slate-900 px-2 py-1 text-[11px] font-bold capitalize text-slate-200">
                {displayStatus === "pending" ? (
                  <Clock3 aria-hidden="true" className="size-3" />
                ) : displayStatus === "approved" ? (
                  <CheckCircle2 aria-hidden="true" className="size-3" />
                ) : (
                  <CircleAlert aria-hidden="true" className="size-3" />
                )}
                {displayStatus}
              </span>
            </div>
            {correctionLabel ? (
              <p className="mt-2 text-xs font-semibold text-cyan-100">
                {correctionLabel}
              </p>
            ) : null}
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-slate-400">Date</dt>
                <dd className="mt-0.5 text-slate-300">{row.purchaseDate}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Submitted by</dt>
                <dd className="mt-0.5 truncate text-slate-300">
                  {row.submitter?.name ?? "Legacy entry"}
                </dd>
              </div>
              {row.dumpDetails ||
              row.categoryId === "dump_fees" ||
              row.allocations.some(
                (allocation) => allocation.categoryId === "dump_fees",
              ) ? (
                <div className="col-span-2">
                  <dt className="text-slate-400">Dump weight</dt>
                  <dd className="mt-0.5 font-semibold text-cyan-100">
                    {row.dumpDetails?.weightStatus === "confirmed" &&
                    row.dumpDetails.netWeightPounds
                      ? formatExpenseDumpWeight(row.dumpDetails.netWeightPounds)
                      : row.dumpDetails?.weightStatus === "unreadable"
                        ? "Net weight unreadable"
                        : "Not recorded"}
                    {row.dumpDetails?.material
                      ? ` · ${row.dumpDetails.material}`
                      : ""}
                  </dd>
                </div>
              ) : null}
              {row.coveredByFixedCostSeriesId ? (
                <div className="col-span-2">
                  <dt className="text-slate-400">Overview</dt>
                  <dd className="mt-0.5 font-semibold text-cyan-100">
                    Excluded from Overview — covered by{" "}
                    {row.coveredByFixedCostName ?? "a fixed monthly cost"}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-slate-400">Paid by</dt>
                <dd className="mt-0.5 text-slate-300">
                  {row.payerType === "personal"
                    ? (row.paidByMember?.name ?? "Employee-paid")
                    : "Company"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Reimbursement</dt>
                <dd className="mt-0.5 capitalize text-slate-300">
                  {row.reimbursement?.status?.replaceAll("_", " ") ?? "None"}
                </dd>
              </div>
            </dl>
            {row.reviewReason ? (
              <p className="mt-3 rounded-lg border border-white/10 bg-slate-950 p-2 text-xs leading-5 text-slate-300">
                {row.reviewReason}
              </p>
            ) : null}
            {row.dumpDetails ? (
              <details className="mt-3 rounded-lg border border-white/10 bg-slate-950/40 p-3">
                <summary
                  className={`${focusRing} flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100`}
                >
                  Scale ticket details
                </summary>
                <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-white/10 pt-3 text-xs">
                  {row.dumpDetails.facilityName ? (
                    <div className="col-span-2">
                      <dt className="text-slate-500">Facility</dt>
                      <dd className="mt-1 break-words text-slate-200">
                        {row.dumpDetails.facilityName}
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.ticketNumber ? (
                    <div>
                      <dt className="text-slate-500">Ticket number</dt>
                      <dd className="mt-1 break-words text-slate-200">
                        {row.dumpDetails.ticketNumber}
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.material ? (
                    <div>
                      <dt className="text-slate-500">Material</dt>
                      <dd className="mt-1 break-words text-slate-200">
                        {row.dumpDetails.material}
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.grossWeightPounds !== null ? (
                    <div>
                      <dt className="text-slate-500">Gross weight</dt>
                      <dd className="mt-1 text-slate-200">
                        {expenseWeightFormatter.format(
                          row.dumpDetails.grossWeightPounds,
                        )}{" "}
                        lb
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.tareWeightPounds !== null ? (
                    <div>
                      <dt className="text-slate-500">Tare weight</dt>
                      <dd className="mt-1 text-slate-200">
                        {expenseWeightFormatter.format(
                          row.dumpDetails.tareWeightPounds,
                        )}{" "}
                        lb
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-slate-500">Net weight</dt>
                    <dd className="mt-1 text-slate-200">
                      {row.dumpDetails.weightStatus === "confirmed" &&
                      row.dumpDetails.netWeightPounds
                        ? formatExpenseDumpWeight(
                            row.dumpDetails.netWeightPounds,
                          )
                        : "Unreadable"}
                    </dd>
                  </div>
                  {row.dumpDetails.billedWeightMilliTons !== null ? (
                    <div>
                      <dt className="text-slate-500">Billed weight</dt>
                      <dd className="mt-1 text-slate-200">
                        {formatExpenseDumpTons(
                          row.dumpDetails.billedWeightMilliTons,
                        )}
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.unitRateCentsPerTon !== null ? (
                    <div>
                      <dt className="text-slate-500">Unit rate</dt>
                      <dd className="mt-1 text-slate-200">
                        {formatExpenseMoney(
                          row.dumpDetails.unitRateCentsPerTon,
                        )}{" "}
                        / ton
                      </dd>
                    </div>
                  ) : null}
                  {row.dumpDetails.confirmedBy ||
                  row.dumpDetails.confirmedAt ? (
                    <div className="col-span-2">
                      <dt className="text-slate-500">Weight confirmation</dt>
                      <dd className="mt-1 text-slate-200">
                        {[
                          row.dumpDetails.confirmedBy?.name,
                          formatExpenseDumpConfirmation(
                            row.dumpDetails.confirmedAt,
                          ),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </details>
            ) : null}
            <div className="mt-3 flex gap-2">
              {row.receipt ? (
                <a
                  href={expenseHistoryReceiptHref(row) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className={`${secondaryButton} flex flex-1 items-center justify-center`}
                >
                  Receipt
                </a>
              ) : null}
              {canCorrectDumpWeight ? (
                <button
                  type="button"
                  onClick={() => {
                    setCorrectingDump(row);
                    setCorrectionDumpDetails(
                      expenseDumpDetailsDraft(row.dumpDetails),
                    );
                    setCorrectionRemoveDumpDetails(false);
                    setCorrectionReason("");
                    setError(null);
                    setSuccess(null);
                  }}
                  className={`${secondaryButton} flex-1`}
                >
                  {row.dumpDetails ? "Correct weight" : "Add weight"}
                </button>
              ) : null}
              {canApprove && row.reviewStatus === "pending" ? (
                <button
                  type="button"
                  onClick={() => {
                    setReviewing(row);
                    setReviewCategoryId(row.categoryId ?? "");
                    setReviewDumpDetails(
                      expenseDumpDetailsDraft(row.dumpDetails),
                    );
                    setReviewNotScaleTicket(false);
                    setReviewCoveredByFixedCostSeriesId(
                      row.coveredByFixedCostSeriesId ?? "",
                    );
                    setLockVendorRule(false);
                    setError(null);
                  }}
                  className={`${secondaryButton} flex-1`}
                >
                  Review
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
      {historyHasMore ? (
        <button
          type="button"
          disabled={historyLoadingMore}
          onClick={() => void loadMoreHistory()}
          className={`${secondaryButton} w-full`}
        >
          {historyLoadingMore ? "Loading…" : "Load more expenses"}
        </button>
      ) : null}
      {!loading && !rows.length ? (
        <div className={`${cardClass} text-sm text-slate-300`}>
          No expenses match this filter.
        </div>
      ) : null}
    </div>
  );
}

export function MobileSpendV2({
  employee,
  canSubmit,
  canApprove,
  canViewOverview,
  canWriteAdSpend,
  members,
  jobs,
}: {
  employee: MemberOption;
  canSubmit: boolean;
  canApprove: boolean;
  canViewOverview: boolean;
  canWriteAdSpend: boolean;
  members: MemberOption[];
  jobs: JobOption[];
}) {
  const yesterday = addDateKeyDays(easternDateKey(), -1);
  const [view, setView] = React.useState<SpendView>("add");
  const [workflow, setWorkflow] = React.useState<AddWorkflow>(null);
  const [capabilities, setCapabilities] =
    React.useState<ExpenseCapabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = React.useState<
    string | null
  >(null);
  const [categories, setCategories] = React.useState<ExpenseCategory[]>([]);
  const [activeCapture, setActiveCapture] =
    React.useState<ExpenseCaptureQueueRow | null>(null);
  const [missingYesterday, setMissingYesterday] = React.useState(false);
  const [adDate, setAdDate] = React.useState(yesterday);
  const [weekStart, setWeekStart] = React.useState(
    mondayForDateKey(easternDateKey()),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [manualDuplicateRisk, setManualDuplicateRisk] = React.useState<
    "scale_ticket" | null
  >(null);
  const [notice, setNotice] = React.useState<{
    message: string;
    tone: "error" | "success";
  } | null>(null);
  const [historyRefresh, setHistoryRefresh] = React.useState(0);
  const receiptEnabled = Boolean(
    canSubmit && capabilities?.receiptCapture === true,
  );
  const adSpendEnabled = Boolean(
    canWriteAdSpend && capabilities?.dailyAdSpend === true,
  );
  const overviewEnabled = Boolean(
    canViewOverview && capabilities?.overview === true,
  );
  const reimbursementEnabled = Boolean(
    canSubmit && capabilities?.reimbursement === true,
  );
  const exactDuplicateReviewEnabled = Boolean(
    canApprove && capabilities?.exactDuplicateReview === true,
  );
  const fixedCostsEnabled = Boolean(
    canApprove && canViewOverview && capabilities?.fixedCosts === true,
  );
  const dumpTicketsEnabled = capabilities?.dumpTickets === true;

  React.useEffect(() => {
    let active = true;
    setCapabilities(null);
    setCapabilitiesError(null);
    void fetch("/api/mobile/expenses/capabilities", {
      cache: "no-store",
      credentials: "include",
    })
      .then(async (response) => ({
        response,
        payload: await jsonPayload(response),
      }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (!response.ok) {
          throw new Error(
            expenseErrorMessage(
              payload,
              "Optional expense tools are unavailable.",
            ),
          );
        }
        const value = objectValue(payload?.["capabilities"]);
        if (!value) throw new Error("Optional expense tools are unavailable.");
        setCapabilities({
          manualEntry: value["manualEntry"] === true,
          receiptCapture: value["receiptCapture"] === true,
          reimbursement: value["reimbursement"] === true,
          dailyAdSpend: value["dailyAdSpend"] === true,
          overview: value["overview"] === true,
          exactDuplicateReview: value["exactDuplicateReview"] === true,
          fixedCosts: value["fixedCosts"] === true,
          dumpTickets: value["dumpTickets"] === true,
        });
      })
      .catch(
        (reasonValue: unknown) =>
          active &&
          setCapabilitiesError(
            reasonValue instanceof Error
              ? reasonValue.message
              : "Optional expense tools are unavailable.",
          ),
      );
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    if (!capabilities) return;
    if (view === "overview" && !overviewEnabled) {
      setView("add");
      setWorkflow(null);
    } else if (
      (workflow === "scan" && !receiptEnabled) ||
      (workflow === "ads" && !adSpendEnabled)
    ) {
      setWorkflow(null);
    }
  }, [
    adSpendEnabled,
    capabilities,
    overviewEnabled,
    receiptEnabled,
    view,
    workflow,
  ]);

  React.useEffect(() => {
    if (!canSubmit && !canApprove) return;
    void fetch("/api/mobile/expenses/categories", { cache: "no-store" })
      .then(async (response) => ({
        response,
        payload: await jsonPayload(response),
      }))
      .then(({ response, payload }) => {
        if (!response.ok)
          throw new Error(
            expenseErrorMessage(payload, "Expense categories are unavailable."),
          );
        setCategories(
          Array.isArray(payload?.["categories"])
            ? (payload["categories"] as ExpenseCategory[])
            : [],
        );
      })
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Expense categories are unavailable.",
        }),
      );
  }, [canApprove, canSubmit]);

  const reloadQueue = React.useCallback(() => {
    void listExpenseCaptureQueue(employee.id)
      .then((rows) => setActiveCapture(rows[0] ?? null))
      .catch(() => undefined);
  }, [employee.id]);

  React.useEffect(() => {
    reloadQueue();
    if (receiptEnabled) {
      void syncEmployeeExpenseCaptures(employee.id)
        .then(reloadQueue)
        .catch(() => undefined);
    }
    const onOnline = () => {
      if (receiptEnabled) {
        void syncEmployeeExpenseCaptures(employee.id)
          .then(reloadQueue)
          .catch(() => undefined);
      }
    };
    const onQueue = () => reloadQueue();
    const onWorker = (event: MessageEvent<unknown>) => {
      if (
        objectValue(event.data)?.["type"] === "stonegate-expense-sync-complete"
      )
        reloadQueue();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener(MOBILE_EXPENSE_QUEUE_EVENT, onQueue);
    navigator.serviceWorker?.addEventListener("message", onWorker);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(MOBILE_EXPENSE_QUEUE_EVENT, onQueue);
      navigator.serviceWorker?.removeEventListener("message", onWorker);
    };
  }, [employee.id, receiptEnabled, reloadQueue]);

  React.useEffect(() => {
    const captureId = activeCapture?.clientCaptureId;
    const captureStatus = activeCapture?.status;
    if (
      !receiptEnabled ||
      !captureId ||
      !captureStatus ||
      !shouldPollExpenseCaptureStatus(captureStatus)
    ) {
      return;
    }
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void refreshExpenseCapture(captureId)
        .then(setActiveCapture)
        .catch(() => undefined);
    };
    refresh();
    const poll = window.setInterval(refresh, 2500);
    return () => window.clearInterval(poll);
  }, [activeCapture?.clientCaptureId, activeCapture?.status, receiptEnabled]);

  React.useEffect(() => {
    if (!adSpendEnabled) {
      setMissingYesterday(false);
      return;
    }
    void fetch(
      `/api/mobile/expenses/daily-ad-spend?businessDate=${encodeURIComponent(yesterday)}`,
      { cache: "no-store" },
    )
      .then(async (response) => (response.ok ? jsonPayload(response) : null))
      .then((payload) =>
        setMissingYesterday(
          Boolean(payload && (!payload["facebook"] || !payload["google"])),
        ),
      )
      .catch(() => undefined);
  }, [adSpendEnabled, yesterday, historyRefresh]);

  const done = (message: string) => {
    setNotice({ tone: "success", message });
    setManualDuplicateRisk(null);
    setWorkflow(null);
    setHistoryRefresh((value) => value + 1);
  };

  const manualSubmit = async (
    body: SubmissionBody,
    duplicateOverrideReason: string | null,
  ) => {
    setSubmitting(true);
    setNotice(null);
    const requestBody = {
      ...body,
      ...(duplicateOverrideReason
        ? { exactDuplicateOverrideReason: duplicateOverrideReason }
        : {}),
    };
    try {
      const attempt = await getExpenseMutationAttempt({
        employeeId: employee.id,
        operation: "manual-expense-submit",
        payload: requestBody,
      });
      const response = await fetch("/api/mobile/expenses/submissions", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
      const payload = await jsonPayload(response);
      if (!response.ok) {
        if (expenseConfirmationDuplicateKind(response.status, payload)) {
          setManualDuplicateRisk("scale_ticket");
        }
        setNotice({
          tone: "error",
          message: expenseErrorMessage(
            payload,
            "The expense was not submitted.",
          ),
        });
        return;
      }
      await acknowledgeExpenseMutationAttempt(attempt);
      setManualDuplicateRisk(null);
      const data = objectValue(payload?.["data"]);
      done(
        data?.["reviewStatus"] === "pending"
          ? "Expense submitted for owner approval."
          : "Expense posted.",
      );
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error &&
          error.message.startsWith("Secure expense retry storage")
            ? error.message
            : "The connection was interrupted. Nothing was reported as posted; retry the same entry.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const changeView = (next: SpendView) => {
    setView(next);
    setWorkflow(null);
    setManualDuplicateRisk(null);
    setNotice(null);
  };

  const openMissingAd = (date: string) => {
    setAdDate(date);
    setView("add");
    setWorkflow("ads");
    setNotice(null);
  };
  const memberOptions = members.some((member) => member.id === employee.id)
    ? members
    : [employee, ...members];

  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
          Spend
        </p>
        <h2 className="mt-1 text-lg font-semibold">
          Expenses without the paperwork pile
        </h2>
      </div>
      <SegmentedControl
        value={view}
        onChange={changeView}
        showOverview={overviewEnabled}
      />
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {!capabilities && !capabilitiesError
          ? "Loading optional expense tools"
          : capabilitiesError
            ? "Optional expense tools are unavailable"
            : "Optional expense tools loaded"}
      </div>
      {capabilitiesError ? (
        <StatusNotice tone="info" message={capabilitiesError} />
      ) : null}
      {notice ? (
        <StatusNotice tone={notice.tone} message={notice.message} />
      ) : null}
      {view === "add" ? (
        workflow === null ? (
          <AddChoices
            canSubmit={canSubmit}
            receiptEnabled={receiptEnabled}
            adSpendEnabled={adSpendEnabled}
            pendingCapture={activeCapture}
            missingYesterday={missingYesterday}
            onChoose={(choice) => {
              if (choice === "ads") setAdDate(yesterday);
              setManualDuplicateRisk(null);
              setWorkflow(choice);
              setNotice(null);
            }}
          />
        ) : workflow === "scan" ? (
          <ReceiptWorkflow
            row={activeCapture}
            employeeId={employee.id}
            categories={categories}
            currentMember={employee}
            members={memberOptions}
            jobs={jobs}
            canApprove={canApprove}
            allowReimbursement={reimbursementEnabled}
            fixedCostCoverageEnabled={fixedCostsEnabled}
            dumpTicketsEnabled={dumpTicketsEnabled}
            onRow={setActiveCapture}
            onDone={done}
            onBack={() => setWorkflow(null)}
          />
        ) : workflow === "manual" ? (
          <div className={cardClass}>
            <div className="mb-4">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
                Manual expense
              </p>
              <h2 className="mt-1 text-lg font-semibold">
                Enter the essentials
              </h2>
            </div>
            <ExpenseEditor
              categories={categories}
              currentMember={employee}
              memberOptions={memberOptions}
              jobs={jobs}
              canApprove={canApprove}
              allowReimbursement={reimbursementEnabled}
              fixedCostCoverageEnabled={fixedCostsEnabled}
              dumpTicketsEnabled={dumpTicketsEnabled}
              duplicateRisk={manualDuplicateRisk ? "exact" : null}
              submitting={submitting}
              submitLabel={canApprove ? "Post expense" : "Submit for approval"}
              onBack={() => {
                setManualDuplicateRisk(null);
                setWorkflow(null);
              }}
              onDumpIdentityChange={() => {
                setManualDuplicateRisk(null);
                setNotice(null);
              }}
              onSubmit={(body, duplicateOverrideReason) =>
                manualSubmit(body, duplicateOverrideReason)
              }
            />
          </div>
        ) : (
          <DailyAdWorkflow
            employeeId={employee.id}
            initialDate={adDate}
            onBack={() => setWorkflow(null)}
            onSaved={done}
          />
        )
      ) : view === "overview" && overviewEnabled ? (
        <OverviewView
          weekStart={weekStart}
          onWeekStart={setWeekStart}
          onMissingAd={openMissingAd}
          canEnterAdSpend={adSpendEnabled}
          canManageFixedCosts={fixedCostsEnabled}
          employeeId={employee.id}
          categories={categories}
        />
      ) : view === "history" ? (
        <HistoryView
          employeeId={employee.id}
          currentMember={employee}
          memberOptions={memberOptions}
          categories={categories}
          jobs={jobs}
          canSubmit={canSubmit}
          canApprove={canApprove}
          allowReimbursement={reimbursementEnabled}
          exactDuplicateReviewEnabled={exactDuplicateReviewEnabled}
          fixedCostCoverageEnabled={fixedCostsEnabled}
          dumpTicketsEnabled={dumpTicketsEnabled}
          refreshToken={historyRefresh}
        />
      ) : null}
    </div>
  );
}
