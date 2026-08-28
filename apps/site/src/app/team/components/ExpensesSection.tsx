import { randomUUID } from "node:crypto";
import React from "react";
import Link from "next/link";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs, fmtMoney } from "../lib/api";
import { teamSurfaceHref } from "../surface-registry";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";
import { ExpenseExportButton } from "./ExpenseExportButton";

type ExpenseLifecycleStatus = "draft" | "posted" | "voided" | "corrected";

type ExpenseListItem = {
  id: string;
  amountCents: number;
  currency: string;
  category: string | null;
  vendor: string | null;
  memo: string | null;
  method: string | null;
  source: string;
  paidAt: string;
  coverageStartAt: string | null;
  coverageEndAt: string | null;
  lifecycleStatus: ExpenseLifecycleStatus;
  version: number;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  correctedAt: string | null;
  correctionReason: string | null;
  reversalOfExpenseId: string | null;
  correctionOfExpenseId: string | null;
  correctedByExpenseId: string | null;
  coveredByFixedCostSeriesId: string | null;
  coveredByFixedCostName: string | null;
  externallyManaged: boolean;
  requiresFinanceReview: boolean;
  receipt: { filename: string; contentType: string } | null;
};

type ExpensesListPayload = {
  ok: true;
  expenses: ExpenseListItem[];
  page: {
    limit: number;
    hasMore: boolean;
    hasPrevious: boolean;
    previousCursor: string | null;
    nextCursor: string | null;
  };
};
type WindowSummary = { totalCents: number; count: number };
type ExpensesSummaryPayload = {
  ok: true;
  currency: string;
  windows: {
    last30Days: WindowSummary;
    monthToDate: WindowSummary;
    yearToDate: WindowSummary;
  };
  dailyTotals: Array<{ day: string; totalCents: number }>;
};

const INPUT_CLASS =
  "min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-200";

const EXPENSE_PAGE_LIMIT = 25;
const EXPENSE_VIEWS = ["add", "ledger", "summary"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,800}$/u;
type ExpenseView = (typeof EXPENSE_VIEWS)[number];

type ExpenseFilters = {
  from?: string;
  to?: string;
  status?: string;
  category?: string;
  source?: string;
  financeReview?: string;
  q?: string;
  cursor?: string;
  direction?: string;
  page?: string;
};

type ExpenseLoadProblem = {
  kind:
    | "unauthorized"
    | "forbidden"
    | "invalid"
    | "server"
    | "network"
    | "malformed";
  message: string;
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isNullableIsoDateString(value: unknown): value is string | null {
  return value === null || isIsoDateString(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && UUID_PATTERN.test(value))
  );
}

function isExpenseListItem(value: unknown): value is ExpenseListItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item["id"] === "string" &&
    UUID_PATTERN.test(item["id"]) &&
    typeof item["amountCents"] === "number" &&
    Number.isSafeInteger(item["amountCents"]) &&
    typeof item["currency"] === "string" &&
    item["currency"].length >= 3 &&
    item["currency"].length <= 8 &&
    isNullableString(item["category"]) &&
    isNullableString(item["vendor"]) &&
    isNullableString(item["memo"]) &&
    isNullableString(item["method"]) &&
    typeof item["source"] === "string" &&
    isIsoDateString(item["paidAt"]) &&
    isNullableIsoDateString(item["coverageStartAt"]) &&
    isNullableIsoDateString(item["coverageEndAt"]) &&
    ["draft", "posted", "voided", "corrected"].includes(
      String(item["lifecycleStatus"]),
    ) &&
    typeof item["version"] === "number" &&
    Number.isSafeInteger(item["version"]) &&
    item["version"] >= 1 &&
    isNullableIsoDateString(item["postedAt"]) &&
    isNullableIsoDateString(item["voidedAt"]) &&
    isNullableString(item["voidReason"]) &&
    isNullableIsoDateString(item["correctedAt"]) &&
    isNullableString(item["correctionReason"]) &&
    isNullableUuid(item["reversalOfExpenseId"]) &&
    isNullableUuid(item["correctionOfExpenseId"]) &&
    isNullableUuid(item["correctedByExpenseId"]) &&
    (item["coveredByFixedCostSeriesId"] === undefined ||
      isNullableUuid(item["coveredByFixedCostSeriesId"])) &&
    (item["coveredByFixedCostName"] === undefined ||
      isNullableString(item["coveredByFixedCostName"])) &&
    typeof item["externallyManaged"] === "boolean" &&
    typeof item["requiresFinanceReview"] === "boolean" &&
    (item["receipt"] === null ||
      (typeof item["receipt"] === "object" &&
        !Array.isArray(item["receipt"]) &&
        typeof (item["receipt"] as Record<string, unknown>)["filename"] ===
          "string" &&
        typeof (item["receipt"] as Record<string, unknown>)["contentType"] ===
          "string"))
  );
}

function parseExpenseListPayload(value: unknown): ExpensesListPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const page = payload["page"];
  if (
    payload["ok"] !== true ||
    !Array.isArray(payload["expenses"]) ||
    !payload["expenses"].every(isExpenseListItem) ||
    !page ||
    typeof page !== "object" ||
    Array.isArray(page)
  ) {
    return null;
  }
  const pageRecord = page as Record<string, unknown>;
  if (
    typeof pageRecord["limit"] !== "number" ||
    !Number.isSafeInteger(pageRecord["limit"]) ||
    pageRecord["limit"] !== EXPENSE_PAGE_LIMIT ||
    typeof pageRecord["hasMore"] !== "boolean" ||
    typeof pageRecord["hasPrevious"] !== "boolean" ||
    !isNullableString(pageRecord["previousCursor"]) ||
    !isNullableString(pageRecord["nextCursor"]) ||
    (typeof pageRecord["previousCursor"] === "string" &&
      !CURSOR_PATTERN.test(pageRecord["previousCursor"])) ||
    (typeof pageRecord["nextCursor"] === "string" &&
      !CURSOR_PATTERN.test(pageRecord["nextCursor"])) ||
    (pageRecord["hasMore"] === true && !pageRecord["nextCursor"]) ||
    (pageRecord["hasPrevious"] === true && !pageRecord["previousCursor"])
  ) {
    return null;
  }
  return value as ExpensesListPayload;
}

function parseExpensesSummaryPayload(
  value: unknown,
): ExpensesSummaryPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<ExpensesSummaryPayload>;
  const windows = payload.windows;
  if (
    payload.ok !== true ||
    typeof payload.currency !== "string" ||
    !/^[A-Z]{3,8}$/u.test(payload.currency) ||
    !windows ||
    !Array.isArray(payload.dailyTotals)
  ) {
    return null;
  }
  for (const window of [
    windows.last30Days,
    windows.monthToDate,
    windows.yearToDate,
  ]) {
    if (
      !window ||
      typeof window.totalCents !== "number" ||
      !Number.isSafeInteger(window.totalCents) ||
      typeof window.count !== "number" ||
      !Number.isSafeInteger(window.count) ||
      window.count < 0
    ) {
      return null;
    }
  }
  if (
    !payload.dailyTotals.every(
      (row) =>
        row &&
        typeof row.day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(row.day) &&
        typeof row.totalCents === "number" &&
        Number.isSafeInteger(row.totalCents),
    )
  ) {
    return null;
  }
  return payload as ExpensesSummaryPayload;
}

async function responseProblem(
  response: Response,
): Promise<ExpenseLoadProblem> {
  if (response.status === 401) {
    return {
      kind: "unauthorized",
      message: "Your Team session expired. Sign in again, then retry.",
    };
  }
  if (response.status === 403) {
    return {
      kind: "forbidden",
      message: "You do not have permission to view this expense information.",
    };
  }
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    return {
      kind: "invalid",
      message:
        typeof body?.message === "string" && body.message.trim()
          ? body.message.trim()
          : "One or more expense filters are invalid. Reset them and try again.",
    };
  }
  return {
    kind: "server",
    message:
      response.status >= 500
        ? `The expense service failed (HTTP ${response.status}). Try again.`
        : `The expense request failed (HTTP ${response.status}).`,
  };
}

function expenseFilterQuery(
  filters: ExpenseFilters,
  options: {
    view?: ExpenseView;
    cursor?: string | null;
    direction?: "next" | "previous" | null;
    page?: number;
  } = {},
): Record<string, string | undefined> {
  return {
    expenseView: options.view ?? "ledger",
    expenseFrom: filters.from,
    expenseTo: filters.to,
    expenseStatus: filters.status,
    expenseCategory: filters.category,
    expenseSource: filters.source,
    expenseReview: filters.financeReview,
    expenseQ: filters.q,
    expenseCursor: options.cursor ?? undefined,
    expenseDirection: options.direction ?? undefined,
    expensePage:
      options.page && options.page > 1 ? String(options.page) : undefined,
  };
}

function apiExpenseFilterQuery(filters: ExpenseFilters): URLSearchParams {
  const query = new URLSearchParams({ limit: String(EXPENSE_PAGE_LIMIT) });
  for (const [key, value] of [
    ["from", filters.from],
    ["to", filters.to],
    ["status", filters.status],
    ["category", filters.category],
    ["source", filters.source],
    ["financeReview", filters.financeReview],
    ["q", filters.q],
    ["cursor", filters.cursor],
    ["direction", filters.direction],
  ] as const) {
    if (value !== undefined && value.length > 0) query.set(key, value);
  }
  return query;
}

function dateInputValue(iso?: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function statusClass(status: ExpenseLifecycleStatus): string {
  if (status === "draft") return "bg-amber-100 text-amber-800";
  if (status === "posted") return "bg-emerald-100 text-emerald-800";
  if (status === "corrected") return "bg-indigo-100 text-indigo-800";
  return "bg-slate-200 text-slate-700";
}

function ExpenseFields({
  expense,
  includeReceipt,
}: {
  expense?: ExpenseListItem;
  includeReceipt: boolean;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Date</span>
        <input
          name="paidDate"
          type="date"
          defaultValue={dateInputValue(expense?.paidAt)}
          className={INPUT_CLASS}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Amount (USD)</span>
        <input
          name="amount"
          type="number"
          inputMode="decimal"
          min="0.01"
          max="1000000"
          step="0.01"
          defaultValue={
            expense ? (expense.amountCents / 100).toFixed(2) : undefined
          }
          placeholder="123.45"
          className={INPUT_CLASS}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Category</span>
        <input
          name="category"
          list="expense-categories"
          maxLength={120}
          defaultValue={expense?.category ?? ""}
          placeholder="Gas, dump, equipment…"
          className={INPUT_CLASS}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Vendor</span>
        <input
          name="vendor"
          maxLength={240}
          defaultValue={expense?.vendor ?? ""}
          placeholder="Home Depot"
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">
          Payment method
        </span>
        <select
          name="method"
          defaultValue={expense?.method ?? ""}
          className={INPUT_CLASS}
        >
          <option value="">Select</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="ach">ACH</option>
          <option value="check">Check</option>
          <option value="zelle">Zelle</option>
          <option value="other">Other</option>
        </select>
      </label>
      <div className="hidden sm:block" aria-hidden="true" />
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">
          Coverage start
        </span>
        <input
          name="coverageStartDate"
          type="date"
          defaultValue={
            expense?.coverageStartAt
              ? dateInputValue(expense.coverageStartAt)
              : ""
          }
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Coverage end</span>
        <input
          name="coverageEndDate"
          type="date"
          defaultValue={
            expense?.coverageEndAt ? dateInputValue(expense.coverageEndAt) : ""
          }
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="text-xs font-medium text-slate-600">Notes</span>
        <textarea
          name="memo"
          rows={3}
          maxLength={2_000}
          defaultValue={expense?.memo ?? ""}
          placeholder="Subscription, job, or receipt details"
          className={INPUT_CLASS}
        />
      </label>
      {includeReceipt ? (
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs font-medium text-slate-600">Receipt</span>
          <input
            name="receiptFile"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
            className={INPUT_CLASS}
          />
          <span className="text-[11px] text-slate-500">
            JPEG, PNG, WebP, HEIC, or PDF; maximum 10 MB. A new file replaces a
            draft&apos;s current receipt.
          </span>
        </label>
      ) : null}
    </div>
  );
}

function ExpenseActions({
  expense,
  canWrite,
}: {
  expense: ExpenseListItem;
  canWrite: boolean;
}): React.ReactElement | null {
  if (expense.requiresFinanceReview) {
    return (
      <p className="text-xs font-medium text-amber-800">
        This historical entry has an amount or currency anomaly and requires
        finance review before any lifecycle change.
      </p>
    );
  }
  if (expense.externallyManaged) {
    return (
      <p className="text-xs text-slate-500">
        Managed by its payout or provider workflow. Changes are unavailable
        here.
      </p>
    );
  }
  if (expense.reversalOfExpenseId) {
    return (
      <p className="text-xs text-slate-500">
        Generated reversal. This ledger evidence is immutable.
      </p>
    );
  }
  if (!canWrite) return null;
  if (expense.lifecycleStatus === "draft") {
    return (
      <div className="flex flex-col gap-3">
        <form
          action={`/api/team/expenses/${encodeURIComponent(expense.id)}/post`}
          method="post"
        >
          <input type="hidden" name="version" value={expense.version} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <button
            type="submit"
            className={teamButtonClass("primary", "sm")}
            aria-label={`Post ${expense.category ?? "expense"} draft`}
          >
            Post expense
          </button>
        </form>
        <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold text-slate-800">
            Edit draft
          </summary>
          <form
            action={`/api/team/expenses/${encodeURIComponent(expense.id)}`}
            method="post"
            encType="multipart/form-data"
            className="mt-3 space-y-4"
          >
            <input type="hidden" name="version" value={expense.version} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <ExpenseFields expense={expense} includeReceipt />
            <button
              type="submit"
              className={teamButtonClass("secondary", "sm")}
            >
              Save draft changes
            </button>
          </form>
        </details>
      </div>
    );
  }
  if (expense.lifecycleStatus !== "posted") return null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-slate-800">
          Correct expense
        </summary>
        <p className="mb-3 text-xs text-slate-600">
          Creates a linked reversal and replacement atomically. The original
          receipt and values remain available as evidence.
        </p>
        <form
          action={`/api/team/expenses/${encodeURIComponent(expense.id)}/correct`}
          method="post"
          className="space-y-4"
        >
          <input type="hidden" name="version" value={expense.version} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <ExpenseFields expense={expense} includeReceipt={false} />
          {expense.coveredByFixedCostSeriesId ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">
                Overview treatment
              </span>
              <select
                name="coveredByFixedCostSeriesId"
                defaultValue={expense.coveredByFixedCostSeriesId}
                className={INPUT_CLASS}
              >
                <option value={expense.coveredByFixedCostSeriesId}>
                  Keep covered by{" "}
                  {expense.coveredByFixedCostName ?? "fixed monthly cost"}
                </option>
                <option value="">Count the replacement separately</option>
              </select>
              <span className="text-[11px] text-slate-500">
                Choose separately if this correction no longer matches the fixed
                monthly amount or category.
              </span>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600">
              Correction reason
            </span>
            <textarea
              name="reason"
              minLength={3}
              maxLength={500}
              rows={2}
              className={INPUT_CLASS}
              required
            />
          </label>
          <button type="submit" className={teamButtonClass("primary", "sm")}>
            Create correction
          </button>
        </form>
      </details>
      <details className="rounded-xl border border-rose-200 bg-rose-50 p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-rose-900">
          Void expense
        </summary>
        <p className="mb-3 text-xs text-rose-800">
          Voiding keeps the original and creates a linked negative entry. It
          does not delete financial history.
        </p>
        <form
          action={`/api/team/expenses/${encodeURIComponent(expense.id)}/void`}
          method="post"
          className="space-y-3"
        >
          <input type="hidden" name="version" value={expense.version} />
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-rose-900">
              Void reason
            </span>
            <textarea
              name="reason"
              minLength={3}
              maxLength={500}
              rows={2}
              className={INPUT_CLASS}
              required
            />
          </label>
          <button type="submit" className={teamButtonClass("danger", "sm")}>
            Void with reversal
          </button>
        </form>
      </details>
    </div>
  );
}

export async function ExpensesSection({
  view: rawView,
  filters = {},
}: {
  view?: string;
  filters?: ExpenseFilters;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const canWrite = hasTeamPermission(principal, "expenses.approve");
  const canExport = hasTeamPermission(principal, "expenses.export");
  const normalizedView = rawView?.trim().toLowerCase() ?? "";
  const viewIsValid =
    !normalizedView || EXPENSE_VIEWS.includes(normalizedView as ExpenseView);
  const activeView: ExpenseView = viewIsValid
    ? ((normalizedView || "ledger") as ExpenseView)
    : "ledger";
  const rawPage = filters.page?.trim() ?? "";
  const parsedPage = rawPage ? Number(rawPage) : 1;
  const pageNumber =
    (!rawPage || /^[1-9]\d*$/u.test(rawPage)) &&
    Number.isSafeInteger(parsedPage) &&
    parsedPage >= 1
      ? parsedPage
      : null;
  const urlProblem: ExpenseLoadProblem | null = !viewIsValid
    ? {
        kind: "invalid",
        message:
          "This expense view is not supported. Choose Add, Ledger, or Summary.",
      }
    : pageNumber === null
      ? {
          kind: "invalid",
          message: "The expense page number is invalid. Reset the ledger.",
        }
      : null;

  let summary: ExpensesSummaryPayload | null = null;
  let summaryProblem: ExpenseLoadProblem | null = null;
  let listPayload: ExpensesListPayload | null = null;
  let ledgerProblem: ExpenseLoadProblem | null = urlProblem;

  if (!urlProblem && activeView === "summary") {
    try {
      const response = await callAdminApiAs(
        principal,
        "/api/admin/expenses/summary",
        { timeoutMs: 8_000 },
      );
      if (!response.ok) {
        summaryProblem = await responseProblem(response);
      } else {
        const payload: unknown = await response.json().catch(() => null);
        summary = parseExpensesSummaryPayload(payload);
        if (!summary) {
          summaryProblem = {
            kind: "malformed",
            message:
              "The expense service returned a malformed summary. No totals are shown.",
          };
        }
      }
    } catch {
      summaryProblem = {
        kind: "network",
        message:
          "The expense service could not be reached. Check the connection and retry.",
      };
    }
  }

  if (!urlProblem && activeView === "ledger") {
    try {
      const apiQuery = apiExpenseFilterQuery(filters);
      const response = await callAdminApiAs(
        principal,
        `/api/admin/expenses?${apiQuery.toString()}`,
        { timeoutMs: 8_000 },
      );
      if (!response.ok) {
        ledgerProblem = await responseProblem(response);
      } else {
        const payload: unknown = await response.json().catch(() => null);
        listPayload = parseExpenseListPayload(payload);
        if (!listPayload) {
          ledgerProblem = {
            kind: "malformed",
            message:
              "The expense service returned malformed ledger data. No entries are shown.",
          };
        }
      }
    } catch {
      ledgerProblem = {
        kind: "network",
        message:
          "The expense service could not be reached. Check the connection and retry.",
      };
    }
  }

  const activeFilters = [
    filters.from,
    filters.to,
    filters.status,
    filters.category,
    filters.source,
    filters.financeReview,
    filters.q,
  ].filter((value) => Boolean(value?.trim())).length;
  const resetHref = teamSurfaceHref("expenses", {
    query: { expenseView: "ledger" },
  });
  const currentLedgerHref = teamSurfaceHref("expenses", {
    query: expenseFilterQuery(filters, {
      cursor: filters.cursor ?? null,
      direction:
        filters.direction === "previous"
          ? "previous"
          : filters.direction === "next"
            ? "next"
            : null,
      page: pageNumber ?? undefined,
    }),
  });
  const exportParams = apiExpenseFilterQuery({
    ...filters,
    cursor: undefined,
    direction: undefined,
  });
  exportParams.delete("limit");
  const exportHref = `/api/team/expenses/export${exportParams.size ? `?${exportParams.toString()}` : ""}`;

  return (
    <section className="space-y-4" aria-labelledby="expenses-heading">
      <header className={TEAM_CARD_PADDED}>
        <h2 id="expenses-heading" className={TEAM_SECTION_TITLE}>
          Expenses
        </h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Save work as a draft, review it, then post it to the financial ledger.
          Posted mistakes are corrected with linked entries so history is never
          silently rewritten.
        </p>
        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Expense views">
          {(
            [
              ...(canWrite
                ? ([{ id: "add", label: "Add draft" }] as const)
                : []),
              { id: "ledger", label: "Ledger" },
              { id: "summary", label: "Summary" },
            ] as const
          ).map((item) => (
            <Link
              key={item.id}
              href={teamSurfaceHref("expenses", {
                query: { expenseView: item.id },
              })}
              className={teamButtonClass(
                activeView === item.id && viewIsValid ? "primary" : "secondary",
                "sm",
              )}
              aria-current={
                activeView === item.id && viewIsValid ? "page" : undefined
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      {urlProblem ? (
        <div className={`${TEAM_CARD_PADDED} border-amber-300`} role="alert">
          <h3 className="font-semibold text-amber-900">Invalid expense URL</h3>
          <p className="mt-1 text-sm text-amber-800">{urlProblem.message}</p>
          <Link
            href={resetHref}
            className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
          >
            Reset to ledger
          </Link>
        </div>
      ) : activeView === "add" && !canWrite ? (
        <div className={`${TEAM_CARD_PADDED} border-amber-300`} role="alert">
          <h3 className="font-semibold text-amber-900">View only</h3>
          <p className="mt-1 text-sm text-amber-800">
            You can review expenses, but your current access cannot create a
            draft.
          </p>
          <Link
            href={resetHref}
            className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
          >
            Open ledger
          </Link>
        </div>
      ) : activeView === "add" ? (
        <div id="expense-add" className={TEAM_CARD_PADDED}>
          <h3
            id="expense-add-title"
            className="text-lg font-semibold text-slate-900"
          >
            Add draft
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Drafts are editable and excluded from totals until you post them.
          </p>
          <form
            action="/api/team/expenses"
            method="post"
            encType="multipart/form-data"
            aria-labelledby="expense-add-title"
            className="mt-4 space-y-4 text-sm text-slate-700"
          >
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <ExpenseFields includeReceipt />
            <button type="submit" className={teamButtonClass("primary")}>
              Save draft
            </button>
          </form>
        </div>
      ) : activeView === "summary" ? (
        <div id="expense-summary" className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Posted spend summary
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Drafts are excluded. Corrections and voids are calculated from
                their immutable ledger entries.
              </p>
            </div>
            <Link
              href={teamSurfaceHref("owner")}
              className={teamButtonClass("secondary", "sm")}
            >
              Owner HQ
            </Link>
          </div>
          {summaryProblem ? (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3"
              role="alert"
            >
              <p className="font-semibold text-amber-900">
                {summaryProblem.kind === "malformed"
                  ? "Invalid summary response"
                  : summaryProblem.kind === "network"
                    ? "Summary unavailable offline"
                    : summaryProblem.kind === "forbidden"
                      ? "Summary access denied"
                      : summaryProblem.kind === "unauthorized"
                        ? "Team session expired"
                        : "Summary unavailable"}
              </p>
              <p className="mt-1 text-sm text-amber-800">
                {summaryProblem.message}
              </p>
              <Link
                href={
                  summaryProblem.kind === "unauthorized"
                    ? "/team/login"
                    : teamSurfaceHref("expenses", {
                        query: { expenseView: "summary" },
                      })
                }
                className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
              >
                {summaryProblem.kind === "unauthorized"
                  ? "Sign in"
                  : "Retry summary"}
              </Link>
            </div>
          ) : null}
          {summary?.ok ? (
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              {[
                { label: "Month to date", window: summary.windows.monthToDate },
                { label: "Last 30 days", window: summary.windows.last30Days },
                { label: "Year to date", window: summary.windows.yearToDate },
              ].map(({ label, window }) => (
                <li
                  key={label}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div>
                    <div className="font-semibold text-slate-900">{label}</div>
                    <div className="text-xs text-slate-600">
                      {window.count} current posted entries
                    </div>
                  </div>
                  <div className="text-right font-semibold text-slate-900">
                    {fmtMoney(window.totalCents, summary.currency)}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {summary?.dailyTotals?.length ? (
            <div className="mt-5">
              <h4 className="text-sm font-semibold text-slate-900">
                Last seven days
              </h4>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {summary.dailyTotals.map((row) => (
                  <div
                    key={row.day}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2"
                  >
                    <div className="font-semibold text-slate-900">
                      {row.day}
                    </div>
                    <div className="text-slate-600">
                      {fmtMoney(row.totalCents, summary.currency)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div id="expense-ledger" className={TEAM_CARD_PADDED}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Expense ledger
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Stable pages of {EXPENSE_PAGE_LIMIT} entries. Draft, posted,
                corrected, voided, and generated reversals are explicit.
              </p>
            </div>
            {canExport ? <ExpenseExportButton href={exportHref} /> : null}
          </div>

          <form
            action="/team/expenses"
            method="get"
            className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-4"
            aria-label="Expense ledger filters"
          >
            <input type="hidden" name="expenseView" value="ledger" />
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-slate-700">
                Search vendor, category, or memo
              </span>
              <input
                name="expenseQ"
                type="search"
                defaultValue={filters.q ?? ""}
                maxLength={160}
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">From</span>
              <input
                name="expenseFrom"
                type="date"
                defaultValue={filters.from ?? ""}
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">
                Through
              </span>
              <input
                name="expenseTo"
                type="date"
                defaultValue={filters.to ?? ""}
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">Status</span>
              <select
                name="expenseStatus"
                defaultValue={filters.status ?? ""}
                className={INPUT_CLASS}
              >
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="corrected">Corrected</option>
                <option value="voided">Voided</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">
                Finance review
              </span>
              <select
                name="expenseReview"
                defaultValue={filters.financeReview ?? ""}
                className={INPUT_CLASS}
              >
                <option value="">All review states</option>
                <option value="required">Review required</option>
                <option value="clear">Clear</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">
                Category
              </span>
              <input
                name="expenseCategory"
                list="expense-categories"
                defaultValue={filters.category ?? ""}
                maxLength={120}
                className={INPUT_CLASS}
                placeholder="Exact category"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">Source</span>
              <select
                name="expenseSource"
                defaultValue={filters.source ?? ""}
                className={INPUT_CLASS}
              >
                <option value="">All sources</option>
                <option value="manual">Manual</option>
                <option value="manual_correction">
                  Correction or reversal
                </option>
                <option value="payout_run">Payout run</option>
                <option value="payout_reimbursement">
                  Payout reimbursement
                </option>
              </select>
            </label>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <button
                type="submit"
                className={teamButtonClass("primary", "sm")}
              >
                Apply filters
              </button>
              <Link
                href={resetHref}
                className={teamButtonClass("secondary", "sm")}
              >
                Reset filters{activeFilters ? ` (${activeFilters})` : ""}
              </Link>
            </div>
          </form>

          {ledgerProblem ? (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3"
              role="alert"
            >
              <p className="font-semibold text-amber-900">
                {ledgerProblem.kind === "invalid"
                  ? "Invalid ledger filters"
                  : ledgerProblem.kind === "forbidden"
                    ? "Ledger access denied"
                    : ledgerProblem.kind === "unauthorized"
                      ? "Team session expired"
                      : ledgerProblem.kind === "network"
                        ? "Ledger unavailable offline"
                        : ledgerProblem.kind === "malformed"
                          ? "Invalid ledger response"
                          : "Ledger service error"}
              </p>
              <p className="mt-1 text-sm text-amber-800">
                {ledgerProblem.message}
              </p>
              {ledgerProblem.kind === "invalid" ? (
                <Link
                  href={resetHref}
                  className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
                >
                  Reset filters
                </Link>
              ) : (
                <Link
                  href={
                    ledgerProblem.kind === "unauthorized"
                      ? "/team/login"
                      : currentLedgerHref
                  }
                  className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
                >
                  {ledgerProblem.kind === "unauthorized"
                    ? "Sign in"
                    : "Retry ledger"}
                </Link>
              )}
            </div>
          ) : null}

          {!ledgerProblem && listPayload?.expenses.length === 0 ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              {listPayload.page.hasPrevious || listPayload.page.hasMore
                ? "This page no longer has entries. Use the available page control to return to ledger results."
                : activeFilters
                  ? "No expenses match these filters. The ledger loaded successfully."
                  : "No expenses yet. Add a draft to begin."}
            </div>
          ) : null}
          {!ledgerProblem && listPayload?.expenses.length ? (
            <div className="mt-4 space-y-3">
              {listPayload.expenses.map((expense) => (
                <article
                  key={expense.id}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700"
                  aria-labelledby={`expense-${expense.id}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4
                          id={`expense-${expense.id}`}
                          className="font-semibold text-slate-900"
                        >
                          {fmtDay(expense.paidAt)} ·{" "}
                          {expense.category ?? "Uncategorized"}
                        </h4>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(expense.lifecycleStatus)}`}
                        >
                          {expense.lifecycleStatus}
                        </span>
                        {expense.reversalOfExpenseId ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                            reversal
                          </span>
                        ) : null}
                        {expense.correctionOfExpenseId ? (
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-800">
                            replacement
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 break-words text-xs text-slate-600">
                        {[expense.vendor, expense.memo]
                          .filter(Boolean)
                          .join(" — ") || "No additional details"}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Source: {expense.source.replace(/_/gu, " ")} · Version{" "}
                        {expense.version}
                      </p>
                      {expense.coverageStartAt || expense.coverageEndAt ? (
                        <p className="mt-1 text-[11px] text-slate-500">
                          Covers{" "}
                          {expense.coverageStartAt
                            ? fmtDay(expense.coverageStartAt)
                            : "?"}{" "}
                          to{" "}
                          {expense.coverageEndAt
                            ? fmtDay(expense.coverageEndAt)
                            : "?"}
                        </p>
                      ) : null}
                      {expense.coveredByFixedCostSeriesId ? (
                        <p className="mt-1 text-xs font-medium text-cyan-800">
                          Kept as evidence and excluded from ordinary Overview
                          expenses — covered by{" "}
                          {expense.coveredByFixedCostName ??
                            "a fixed monthly cost"}
                          .
                        </p>
                      ) : null}
                      {expense.voidReason ? (
                        <p className="mt-1 text-xs text-rose-800">
                          Void reason: {expense.voidReason}
                        </p>
                      ) : null}
                      {expense.correctionReason ? (
                        <p className="mt-1 text-xs text-indigo-800">
                          Correction reason: {expense.correctionReason}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <div className="text-base font-semibold text-slate-900">
                        {fmtMoney(expense.amountCents, expense.currency)}
                      </div>
                      {expense.receipt ? (
                        <a
                          className={teamButtonClass("secondary", "sm")}
                          href={`/api/team/expenses/${encodeURIComponent(expense.id)}/receipt`}
                          target="_blank"
                          rel="noreferrer"
                          title={expense.receipt.filename}
                        >
                          View receipt
                        </a>
                      ) : null}
                    </div>
                  </div>
                  {expense.requiresFinanceReview ||
                  expense.externallyManaged ||
                  expense.reversalOfExpenseId ||
                  (canWrite &&
                    (expense.lifecycleStatus === "draft" ||
                      expense.lifecycleStatus === "posted")) ? (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <ExpenseActions expense={expense} canWrite={canWrite} />
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}

          {!ledgerProblem && listPayload ? (
            <nav
              className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between"
              aria-label="Expense ledger pages"
            >
              <div className="text-sm text-slate-600">
                Page {pageNumber ?? 1} · {listPayload.expenses.length} entries
              </div>
              <div className="flex flex-wrap gap-2">
                {listPayload.page.hasPrevious &&
                listPayload.page.previousCursor ? (
                  <Link
                    href={teamSurfaceHref("expenses", {
                      query: expenseFilterQuery(filters, {
                        cursor: listPayload.page.previousCursor,
                        direction: "previous",
                        page: Math.max(1, (pageNumber ?? 1) - 1),
                      }),
                    })}
                    className={teamButtonClass("secondary", "sm")}
                    rel="prev"
                  >
                    Previous page
                  </Link>
                ) : null}
                {listPayload.page.hasMore && listPayload.page.nextCursor ? (
                  <Link
                    href={teamSurfaceHref("expenses", {
                      query: expenseFilterQuery(filters, {
                        cursor: listPayload.page.nextCursor,
                        direction: "next",
                        page: (pageNumber ?? 1) + 1,
                      }),
                    })}
                    className={teamButtonClass("secondary", "sm")}
                    rel="next"
                  >
                    Next page
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </div>
      )}

      <datalist id="expense-categories">
        <option value="Dump" />
        <option value="Gas" />
        <option value="Food" />
        <option value="Equipment" />
        <option value="Vehicle" />
        <option value="Insurance" />
        <option value="Software" />
      </datalist>
    </section>
  );
}
