import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { callAdminApi } from "../lib/api";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

type RevenueWindow = {
  totalCents: number;
  count: number;
};

type RevenuePayload = {
  ok: true;
  currency: string;
  windows: {
    last30Days: RevenueWindow;
    monthToDate: RevenueWindow;
    yearToDate: RevenueWindow;
  };
};

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
  receipt: { filename: string; contentType: string } | null;
};

type ExpensesListPayload = {
  ok: true;
  expenses: ExpenseListItem[];
};

type ExpenseSummaryWindow = {
  totalCents: number;
  count: number;
};

type ExpensesSummaryPayload = {
  ok: true;
  currency: string;
  windows: {
    last30Days: ExpenseSummaryWindow;
    monthToDate: ExpenseSummaryWindow;
    yearToDate: ExpenseSummaryWindow;
  };
};

function fmtMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export async function OwnerSection(): Promise<React.ReactElement> {
  let revenue: RevenuePayload | null = null;
  let revenueError: string | null = null;
  try {
    const res = await callAdminApi("/api/revenue/summary");
    if (res.ok) {
      revenue = (await res.json()) as RevenuePayload;
    } else {
      revenueError = `Revenue unavailable (HTTP ${res.status})`;
    }
  } catch {
    revenueError = "Revenue unavailable.";
  }

  let expensesSummary: ExpensesSummaryPayload | null = null;
  let expensesSummaryError: string | null = null;
  let recentExpenses: ExpenseListItem[] = [];
  let expensesError: string | null = null;

  try {
    const [summaryRes, listRes] = await Promise.all([
      callAdminApi("/api/admin/expenses/summary"),
      callAdminApi("/api/admin/expenses?limit=8")
    ]);

    if (summaryRes.ok) {
      expensesSummary = (await summaryRes.json()) as ExpensesSummaryPayload;
    } else {
      expensesSummaryError = `Expenses unavailable (HTTP ${summaryRes.status})`;
    }

    if (listRes.ok) {
      const payload = (await listRes.json()) as ExpensesListPayload;
      recentExpenses = payload.expenses ?? [];
    } else {
      expensesError = `Expenses unavailable (HTTP ${listRes.status})`;
    }
  } catch {
    expensesSummaryError = expensesSummaryError ?? "Expenses unavailable.";
    expensesError = expensesError ?? "Expenses unavailable.";
  }

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Owner HQ</h2>
        <p className={TEAM_SECTION_SUBTITLE}>Revenue, expenses, and tools.</p>
      </header>

      <OwnerAssistClient />

      <div className={TEAM_CARD_PADDED}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Revenue</h3>
            <p className="text-sm text-slate-600">Completed appointments (final total when set, otherwise quoted).</p>
          </div>
        </div>
        <div className="mt-4 space-y-2 text-sm text-slate-700">
          {revenueError ? (
            <p className="text-amber-700">{revenueError}</p>
          ) : revenue?.ok ? (
            <ul className="space-y-2">
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">Month to date</div>
                  <div className="text-xs text-slate-600">{revenue.windows.monthToDate.count} jobs</div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(revenue.windows.monthToDate.totalCents, revenue.currency)}
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">Last 30 days</div>
                  <div className="text-xs text-slate-600">{revenue.windows.last30Days.count} jobs</div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(revenue.windows.last30Days.totalCents, revenue.currency)}
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">Year to date</div>
                  <div className="text-xs text-slate-600">{revenue.windows.yearToDate.count} jobs</div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(revenue.windows.yearToDate.totalCents, revenue.currency)}
                </div>
              </li>
            </ul>
          ) : (
            <p className="text-slate-600">No completed appointments yet.</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Expenses</h3>
              <p className="mt-1 text-sm text-slate-600">Ops logs daily totals in the Ops tab.</p>
            </div>
            <a href="/team?tab=expenses" className={teamButtonClass("primary", "sm")}>
              Open
            </a>
          </div>

          {expensesSummaryError ? <p className="mt-3 text-sm text-amber-700">{expensesSummaryError}</p> : null}

          {expensesSummary?.ok ? (
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              {(
                [
                  { label: "Month to date", window: expensesSummary.windows.monthToDate },
                  { label: "Last 30 days", window: expensesSummary.windows.last30Days },
                  { label: "Year to date", window: expensesSummary.windows.yearToDate }
                ] as Array<{ label: string; window: ExpenseSummaryWindow }>
              ).map(({ label, window }) => (
                <li key={label} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <div className="font-semibold text-slate-900">{label}</div>
                    <div className="text-xs text-slate-600">{window.count} expenses</div>
                  </div>
                  <div className="text-right font-semibold text-slate-900">
                    {fmtMoney(window.totalCents, expensesSummary.currency)}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {expensesError ? <p className="mt-3 text-sm text-amber-700">{expensesError}</p> : null}
          {recentExpenses.length ? (
            <div className="mt-4 space-y-2">
              {recentExpenses.map((expense) => (
                <div key={expense.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{fmtDay(expense.paidAt)}</span>
                      {expense.category ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {expense.category}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-slate-600">
                      {[expense.vendor, expense.memo].filter(Boolean).join(" — ") || "No details"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{fmtMoney(expense.amountCents, expense.currency)}</span>
                    {expense.receipt ? (
                      <a
                        className={teamButtonClass("secondary", "sm")}
                        href={`/api/team/expenses/${encodeURIComponent(expense.id)}/receipt`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Receipt
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Commissions</h3>
              <p className="mt-1 text-sm text-slate-600">Manage settings and payout runs in Control → Commissions.</p>
            </div>
            <a href="/team?tab=commissions" className={teamButtonClass("secondary", "sm")}>
              Open
            </a>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            Commissions are calculated from completed jobs using final amount paid.
          </p>
        </div>
      </div>

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">P&amp;L</h3>
        <p className="mt-1 text-sm text-slate-600">
          Monthly and yearly P&amp;L will appear once we wire in categories and basic reporting.
        </p>
      </div>
    </section>
  );
}
