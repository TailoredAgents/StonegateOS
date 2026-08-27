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

type SpendView = "add" | "overview" | "history";
type AddWorkflow = "scan" | "manual" | "ads" | null;

type ExpenseCategory = { id: string; name: string; sortOrder?: number };
type MemberOption = { id: string; name: string };
type JobOption = { id: string; label: string; date: string };

type ExpenseCapabilities = {
  manualEntry: boolean;
  receiptCapture: boolean;
  reimbursement: boolean;
  dailyAdSpend: boolean;
  overview: boolean;
  exactDuplicateReview: boolean;
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
  totalExpensesCents: number;
  operatingProfitCents: number;
  expenseRatioPercent: number | null;
  priorWeek: OverviewPeriod;
  priorWeekChange: {
    available: boolean;
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
  vendor: string | null;
  notes: string | null;
  method: "card" | "cash" | "ach" | "check" | "zelle" | "other" | null;
  payerType: "company" | "personal";
  paidByMemberId: string | null;
  appointmentId: string | null;
};

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

async function jsonPayload(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return objectValue(await response.json().catch(() => null));
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
      role="tablist"
    >
      {views.map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={value === view}
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
  const choices: Array<{
    id: Exclude<AddWorkflow, null>;
    label: string;
    detail: string;
    icon: typeof Camera;
    primary: boolean;
    disabled: boolean;
  }> = [];
  if (receiptEnabled) {
    choices.push({
      id: "scan",
      label: pendingCapture ? "Continue receipt" : "Scan receipt",
      detail: pendingCapture
        ? "A receipt is waiting on this device"
        : "Camera or photo upload",
      icon: Camera,
      primary: true,
      disabled: !canSubmit,
    });
  }
  if (adSpendEnabled) {
    choices.push({
      id: "ads",
      label: "Daily ad spend",
      detail: missingYesterday
        ? "Yesterday needs an entry"
        : "Facebook and Google",
      icon: Megaphone,
      primary: false,
      disabled: false,
    });
  }
  choices.push({
    id: "manual",
    label: "Manual entry",
    detail: "Enter an expense without a receipt",
    icon: PencilLine,
    primary: !receiptEnabled,
    disabled: !canSubmit,
  });
  return (
    <div className="space-y-3">
      {choices.map((choice) => {
        const Icon = choice.icon;
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

function ExpenseEditor({
  categories,
  currentMember,
  memberOptions,
  jobs,
  canApprove,
  allowReimbursement,
  initial,
  attentionFields = [],
  vendorPrimary = false,
  duplicateRisk = null,
  submitting,
  submitDisabled = false,
  submitLabel,
  onBack,
  onSubmit,
}: {
  categories: ExpenseCategory[];
  currentMember: MemberOption;
  memberOptions: MemberOption[];
  jobs: JobOption[];
  canApprove: boolean;
  allowReimbursement: boolean;
  initial?: Partial<{
    amount: string;
    purchaseDate: string;
    categoryId: string;
    vendor: string;
    method: string;
  }>;
  attentionFields?: string[];
  vendorPrimary?: boolean;
  duplicateRisk?: "exact" | "fuzzy" | null;
  submitting: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  onBack: () => void;
  onSubmit: (
    body: SubmissionBody,
    duplicateOverrideReason: string | null,
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
  const [appointmentId, setAppointmentId] = React.useState("");
  const [splitEnabled, setSplitEnabled] = React.useState(false);
  const [splits, setSplits] = React.useState<SplitRow[]>([]);
  const [overrideReason, setOverrideReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

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
    if (
      duplicateRisk === "exact" &&
      (!canApprove || overrideReason.trim().length < 10)
    ) {
      setError(
        canApprove
          ? "Add at least 10 characters explaining this exact duplicate override."
          : "Only an owner can override an exact duplicate receipt.",
      );
      return;
    }
    await onSubmit(
      {
        amountCents,
        purchaseDate,
        categoryId,
        ...(allocations ? { allocations } : {}),
        vendor: vendor.trim() || null,
        notes: notes.trim() || null,
        method: method ? (method as SubmissionBody["method"]) : null,
        payerType,
        paidByMemberId: payerType === "personal" ? paidByMemberId : null,
        appointmentId: appointmentId || null,
      },
      duplicateRisk === "exact" ? overrideReason.trim() || null : null,
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
                ? "This is an exact match for another receipt. Confirm why it should be entered again."
                : "This is an exact duplicate. An owner must review it before it can be submitted."
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
      <div aria-live="polite" className="sr-only">
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

function receiptExtractionFromCapture(
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
  const raw = objectValue(extraction?.["raw"]);
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
  onRow: (row: ExpenseCaptureQueueRow | null) => void;
  onDone: (message: string) => void;
  onBack: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [isOnline, setIsOnline] = React.useState(true);

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
    if (!row) return;
    setBusy(true);
    const queued = await queueExpenseCapture(row.clientCaptureId);
    onRow(queued);
    const synchronized = await syncExpenseCapture(row.clientCaptureId);
    onRow(synchronized);
    setBusy(false);
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

  const checkAnalysis = async () => {
    if (!row) return;
    setBusy(true);
    setMessage(null);
    try {
      onRow(await refreshExpenseCapture(row.clientCaptureId));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Receipt status is temporarily unavailable.",
      );
    } finally {
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
      ...(overrideReason
        ? { exactDuplicateOverrideReason: overrideReason }
        : {}),
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
            Keep the full receipt in frame. You will review every value before
            it posts.
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
        />
      </div>
    );
  }

  if (row.status === "queued" || row.status === "syncing") {
    return (
      <div className={`${cardClass} space-y-4 text-center`}>
        <Clock3 aria-hidden="true" className="mx-auto size-9 text-cyan-200" />
        <div aria-live="polite">
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
        <div aria-live="polite">
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
        <p className="text-sm leading-6 text-slate-300" aria-live="polite">
          The background worker may retry this receipt. We will keep checking,
          or you can check again now.
        </p>
        <button
          type="button"
          onClick={() => void checkAnalysis()}
          disabled={busy || !isOnline}
          className={primaryButton}
        >
          <RotateCcw aria-hidden="true" className="mr-2 inline size-4" />
          {busy ? "Checking…" : "Check analysis again"}
        </button>
        <button
          type="button"
          onClick={() => void discard()}
          disabled={busy}
          className={`${secondaryButton} w-full`}
        >
          Discard receipt
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
        initial={extracted.initial}
        attentionFields={extracted.attention}
        vendorPrimary
        duplicateRisk={extracted.duplicateRisk}
        submitting={busy}
        submitLabel={canApprove ? "Post expense" : "Submit for approval"}
        onBack={onBack}
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
      <div aria-live="polite" className="sr-only">
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

function OverviewView({
  weekStart,
  onWeekStart,
  onMissingAd,
  canEnterAdSpend,
}: {
  weekStart: string;
  onWeekStart: (date: string) => void;
  onMissingAd: (date: string) => void;
  canEnterAdSpend: boolean;
}) {
  const [overview, setOverview] = React.useState<OverviewPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
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
        setOverview(payload as unknown as OverviewPayload);
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
  }, [weekStart]);

  const maxCategory = Math.max(
    1,
    ...(overview?.categories.map((category) =>
      Math.abs(category.amountCents),
    ) ?? [1]),
  );
  const firstMissingDate = overview?.missingAdEntries[0]?.businessDate ?? null;
  const headlineCards = overview
    ? [
        {
          label: "Revenue",
          value: formatExpenseMoney(overview.revenueCents),
          change: overview.priorWeekChange.revenuePercent,
          unit: "%",
        },
        {
          label: "Expenses",
          value: formatExpenseMoney(overview.totalExpensesCents),
          change: overview.priorWeekChange.expensesPercent,
          unit: "%",
        },
        {
          label: "Operating profit",
          value: formatExpenseMoney(overview.operatingProfitCents),
          change: overview.priorWeekChange.operatingProfitPercent,
          unit: "%",
        },
        {
          label: "Expense ratio",
          value: formatExpensePercent(overview.expenseRatioPercent),
          change: overview.priorWeekChange.expenseRatioPercentagePoints,
          unit: " pts",
        },
      ]
    : [];
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
      <div aria-live="polite" className="sr-only">
        {loading ? "Loading weekly overview" : ""}
      </div>
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
                <p className="mt-1 text-[11px] text-slate-500">
                  {!overview.priorWeekChange.available
                    ? "Comparison unavailable"
                    : card.change === null
                      ? "Prior baseline was zero"
                      : `${card.change >= 0 ? "+" : ""}${card.change.toFixed(1)}${card.unit} vs prior`}
                </p>
              </div>
            ))}
          </div>
          <section
            className={cardClass}
            aria-labelledby="expense-category-heading"
          >
            <h2
              id="expense-category-heading"
              className="text-base font-semibold"
            >
              Expense categories
            </h2>
            <div className="mt-4 space-y-4">
              {overview.categories.length ? (
                overview.categories.map((category) => (
                  <div key={category.id}>
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">
                          {category.label}
                          {!category.verified ? (
                            <span className="ml-1 text-amber-200">
                              • Needs review
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {formatExpensePercent(category.percentOfExpenses)} of
                          expenses ·{" "}
                          {formatExpensePercent(category.percentOfRevenue)} of
                          revenue
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-bold">
                        {formatExpenseMoney(category.amountCents)}
                      </p>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-cyan-300"
                        style={{
                          width: `${Math.max(2, Math.min(100, (Math.abs(category.amountCents) / maxCategory) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-400">
                  No verified expenses in this week.
                </p>
              )}
            </div>
          </section>
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

function exactDuplicateReceiptHref(captureId: string): string {
  return `/api/mobile/expenses/captures/${encodeURIComponent(captureId)}/content`;
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
  refreshToken: number;
}) {
  const [filter, setFilter] = React.useState("all");
  const [rows, setRows] = React.useState<ExpenseHistoryRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<ExpenseHistoryRow | null>(
    null,
  );
  const [reason, setReason] = React.useState("");
  const [reviewBusy, setReviewBusy] = React.useState(false);
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

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(
      `/api/mobile/expenses/submissions?filter=${encodeURIComponent(filter)}`,
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
            expenseErrorMessage(payload, "Expense history is unavailable."),
          );
        setRows(
          Array.isArray(payload?.["expenses"])
            ? (payload["expenses"] as ExpenseHistoryRow[])
            : [],
        );
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
    setReviewBusy(true);
    setError(null);
    try {
      const requestBody = { decision, reason: reason.trim() || null };
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
      ...(overrideReason
        ? { exactDuplicateOverrideReason: overrideReason }
        : {}),
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

  if (reviewing) {
    const linkedJob = reviewing.appointmentId
      ? (jobs.find((job) => job.id === reviewing.appointmentId) ?? null)
      : null;
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
        <label className="block">
          <FieldLabel>Reason (required to reject)</FieldLabel>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            className={controlClass}
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
            {historyFilters.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div aria-live="polite" className="sr-only">
        {loading
          ? "Loading expense history"
          : `${rows.length} expense entries loaded`}
      </div>
      {error ? <StatusNotice tone="error" message={error} /> : null}
      {rows.map((row) => (
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
              {row.reviewStatus === "pending" ? (
                <Clock3 aria-hidden="true" className="size-3" />
              ) : row.reviewStatus === "approved" ? (
                <CheckCircle2 aria-hidden="true" className="size-3" />
              ) : (
                <CircleAlert aria-hidden="true" className="size-3" />
              )}
              {row.reviewStatus ?? row.lifecycleStatus}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-slate-500">Date</dt>
              <dd className="mt-0.5 text-slate-300">{row.purchaseDate}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Submitted by</dt>
              <dd className="mt-0.5 truncate text-slate-300">
                {row.submitter?.name ?? "Legacy entry"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Paid by</dt>
              <dd className="mt-0.5 text-slate-300">
                {row.payerType === "personal"
                  ? (row.paidByMember?.name ?? "Employee-paid")
                  : "Company"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Reimbursement</dt>
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
          <div className="mt-3 flex gap-2">
            {row.receipt ? (
              <a
                href={
                  row.receipt.captureId
                    ? `/api/mobile/expenses/captures/${encodeURIComponent(row.receipt.captureId)}/content`
                    : `/api/mobile/expenses/${encodeURIComponent(row.id)}/receipt`
                }
                target="_blank"
                rel="noreferrer"
                className={`${secondaryButton} flex flex-1 items-center justify-center`}
              >
                Receipt
              </a>
            ) : null}
            {canApprove && row.reviewStatus === "pending" ? (
              <button
                type="button"
                onClick={() => {
                  setReviewing(row);
                  setError(null);
                }}
                className={`${secondaryButton} flex-1`}
              >
                Review
              </button>
            ) : null}
          </div>
        </article>
      ))}
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
      void syncEmployeeExpenseCaptures(employee.id).then(reloadQueue);
    }
    const onOnline = () => {
      if (receiptEnabled) {
        void syncEmployeeExpenseCaptures(employee.id).then(reloadQueue);
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
    const poll = window.setInterval(
      () => {
        refresh();
      },
      captureStatus === "failed" ? 10_000 : 2500,
    );
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
    setWorkflow(null);
    setHistoryRefresh((value) => value + 1);
  };

  const manualSubmit = async (body: SubmissionBody) => {
    setSubmitting(true);
    setNotice(null);
    try {
      const attempt = await getExpenseMutationAttempt({
        employeeId: employee.id,
        operation: "manual-expense-submit",
        payload: body,
      });
      const response = await fetch("/api/mobile/expenses/submissions", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      const payload = await jsonPayload(response);
      if (!response.ok) {
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
      <div aria-live="polite" className="sr-only">
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
              submitting={submitting}
              submitLabel={canApprove ? "Post expense" : "Submit for approval"}
              onBack={() => setWorkflow(null)}
              onSubmit={(body) => manualSubmit(body)}
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
          refreshToken={historyRefresh}
        />
      ) : null}
    </div>
  );
}
