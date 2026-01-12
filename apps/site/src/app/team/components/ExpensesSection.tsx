import React from "react";
import { callAdminApi, fmtMoney } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

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
  receipt: { filename: string; contentType: string } | null;
};

type ExpensesListPayload = {
  ok: true;
  expenses: ExpenseListItem[];
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

function todayDateInput(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TIME_ZONE, month: "short", day: "numeric" }).format(d);
}

export async function ExpensesSection(): Promise<React.ReactElement> {
  let summary: ExpensesSummaryPayload | null = null;
  let summaryError: string | null = null;
  let expenses: ExpenseListItem[] = [];
  let expensesError: string | null = null;

  try {
    const [summaryRes, listRes] = await Promise.all([
      callAdminApi("/api/admin/expenses/summary"),
      callAdminApi("/api/admin/expenses?limit=25")
    ]);

    if (summaryRes.ok) {
      summary = (await summaryRes.json()) as ExpensesSummaryPayload;
    } else {
      summaryError = `Expenses summary unavailable (HTTP ${summaryRes.status})`;
    }

    if (listRes.ok) {
      const payload = (await listRes.json()) as ExpensesListPayload;
      expenses = payload.expenses ?? [];
    } else {
      expensesError = `Expenses unavailable (HTTP ${listRes.status})`;
    }
  } catch (error) {
    summaryError = summaryError ?? "Expenses unavailable.";
    expensesError = expensesError ?? "Expenses unavailable.";
  }

  const defaultDate = todayDateInput();

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Expenses</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Ops logs daily totals (plus one-off or monthly expenses). Receipts are optional.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={TEAM_CARD_PADDED}>
          <h3 className="text-lg font-semibold text-slate-900">Add expense</h3>
          <p className="mt-1 text-sm text-slate-600">
            Log the total cost for the day, or a subscription/one-off expense with an optional coverage range.
          </p>

          <form
            action="/api/team/expenses"
            method="post"
            encType="multipart/form-data"
            className="mt-4 grid grid-cols-1 gap-4 text-sm text-slate-700 sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Date</span>
              <input name="paidDate" type="date" defaultValue={defaultDate} className="rounded-xl border border-slate-200 bg-white px-3 py-2" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Amount</span>
              <input name="amount" inputMode="decimal" placeholder="e.g. 123.45" className="rounded-xl border border-slate-200 bg-white px-3 py-2" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Category</span>
              <input
                name="category"
                list="expense-categories"
                placeholder="Fuel, dump fees, repairs, marketing..."
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Vendor (optional)</span>
              <input name="vendor" placeholder="e.g. Home Depot" className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Payment method (optional)</span>
              <select name="method" className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <option value="">(Select)</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="ach">ACH</option>
                <option value="check">Check</option>
                <option value="zelle">Zelle</option>
                <option value="other">Other</option>
              </select>
            </label>
            <div className="hidden sm:block" />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Coverage start (optional)</span>
              <input name="coverageStartDate" type="date" className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Coverage end (optional)</span>
              <input name="coverageEndDate" type="date" className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Notes (optional)</span>
              <textarea
                name="memo"
                rows={3}
                placeholder="Optional details (subscription name, receipt notes, etc.)"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Receipt photo (optional)</span>
              <input name="receiptFile" type="file" accept="image/*" className="rounded-xl border border-slate-200 bg-white px-3 py-2" />
              <span className="text-[11px] text-slate-500">Max 10MB.</span>
            </label>

            <datalist id="expense-categories">
              <option value="Fuel" />
              <option value="Dump fees" />
              <option value="Repairs & maintenance" />
              <option value="Supplies" />
              <option value="Subscriptions" />
              <option value="Marketing" />
              <option value="Truck rental" />
              <option value="Insurance" />
              <option value="Payroll" />
              <option value="Other" />
            </datalist>

            <div className="sm:col-span-2">
              <button type="submit" className={teamButtonClass("primary")}>
                Save expense
              </button>
            </div>
          </form>
        </div>

        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Spend summary</h3>
              <p className="mt-1 text-sm text-slate-600">Totals include manual + bank-synced expenses.</p>
            </div>
            <a href="/team?tab=owner" className={teamButtonClass("secondary", "sm")}>
              Owner HQ
            </a>
          </div>

          {summaryError ? <p className="mt-3 text-sm text-amber-700">{summaryError}</p> : null}
          {summary?.ok ? (
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              {(
                [
                  { label: "Month to date", window: summary.windows.monthToDate },
                  { label: "Last 30 days", window: summary.windows.last30Days },
                  { label: "Year to date", window: summary.windows.yearToDate }
                ] as Array<{ label: string; window: WindowSummary }>
              ).map(({ label, window }) => (
                <li key={label} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <div className="font-semibold text-slate-900">{label}</div>
                    <div className="text-xs text-slate-600">{window.count} expenses</div>
                  </div>
                  <div className="text-right font-semibold text-slate-900">{fmtMoney(window.totalCents, summary.currency)}</div>
                </li>
              ))}
            </ul>
          ) : null}

          {summary?.dailyTotals?.length ? (
            <div className="mt-5">
              <h4 className="text-sm font-semibold text-slate-900">Last 7 days</h4>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {summary.dailyTotals.map((row) => (
                  <div key={row.day} className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                    <div className="font-semibold text-slate-900">{row.day}</div>
                    <div className="text-slate-600">{fmtMoney(row.totalCents, summary.currency)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className={TEAM_CARD_PADDED}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Recent expenses</h3>
            <p className="mt-1 text-sm text-slate-600">Latest entries (including subscriptions and daily totals).</p>
          </div>
        </div>

        {expensesError ? <p className="mt-3 text-sm text-amber-700">{expensesError}</p> : null}

        {expenses.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No expenses yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {expenses.map((expense) => (
              <div
                key={expense.id}
                className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{fmtDay(expense.paidAt)}</span>
                    {expense.category ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {expense.category}
                      </span>
                    ) : null}
                    {expense.method ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {expense.method}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-600">
                    {[expense.vendor, expense.memo].filter(Boolean).join(" — ") || "No details"}
                  </div>
                  {expense.coverageStartAt || expense.coverageEndAt ? (
                    <div className="mt-1 text-[11px] text-slate-500">
                      Covers{" "}
                      {expense.coverageStartAt ? fmtDay(expense.coverageStartAt) : "?"}{" "}
                      to{" "}
                      {expense.coverageEndAt ? fmtDay(expense.coverageEndAt) : "?"}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-semibold text-slate-900">{fmtMoney(expense.amountCents, expense.currency)}</div>
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
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
