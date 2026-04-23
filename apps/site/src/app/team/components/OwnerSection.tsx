import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { callAdminApi } from "../lib/api";
import {
  formatAppointmentPricing,
  formatUsdCents,
  type AppointmentBookingDetails,
} from "../lib/booking-details";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type RevenueWindow = {
  totalCents: number;
  count: number;
};

type RevenueWeekJob = {
  appointmentId: string;
  startAt: string;
  completedAt: string | null;
  contactName: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  quotedTotalCents: number | null;
  finalTotalCents: number;
  bookingDetails: AppointmentBookingDetails | null;
};

type RevenuePayload = {
  ok: true;
  currency: string;
  timezone: string;
  windows: {
    weekToDate: RevenueWindow & {
      startsAt: string;
      jobs: RevenueWeekJob[];
    };
    samePaceLastWeek: RevenueWindow & {
      startsAt: string;
      endsAt: string;
    };
    fullLastWeek: RevenueWindow & {
      startsAt: string;
      endsAt: string;
    };
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
    weekToDate: ExpenseSummaryWindow;
    last30Days: ExpenseSummaryWindow;
    monthToDate: ExpenseSummaryWindow;
    yearToDate: ExpenseSummaryWindow;
  };
};

type CommissionSummaryPayload = {
  ok: true;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  scheduledPayoutAt: string;
  cardTipsCents: number;
  totalsCents: {
    sales: number;
    marketing: number;
    crew: number;
    adjustments: number;
    total: number;
  };
};

type OwnerView = "overview" | "revenue" | "expenses" | "payroll" | "pl" | "assistant";

const OWNER_VIEWS: Array<{ id: OwnerView; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Cash flow, alerts, and next actions" },
  { id: "revenue", label: "Revenue", description: "Completed jobs and collected totals" },
  { id: "expenses", label: "Expenses", description: "Spend totals and recent receipts" },
  { id: "payroll", label: "Payroll", description: "Commissions, tips, and payout timing" },
  { id: "pl", label: "P&L", description: "Profit and margin snapshots" },
  { id: "assistant", label: "Assistant", description: "Ask live owner questions" },
];

function isOwnerView(value: string | null | undefined): value is OwnerView {
  return OWNER_VIEWS.some((view) => view.id === value);
}

function normalizeOwnerView(value: string | null | undefined): OwnerView {
  return isOwnerView(value) ? value : "overview";
}

function fmtMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(d);
}

function fmtWindowStart(iso: string, timezone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function fmtWindowEndExclusive(iso: string, timezone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(d.getTime() - 1));
}

function fmtWhen(iso: string, timezone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function fmtPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(0)}%`;
}

function fmtSignedMoney(cents: number, currency: string): string {
  const absolute = fmtMoney(Math.abs(cents), currency);
  if (cents > 0) return `+${absolute}`;
  if (cents < 0) return `-${absolute}`;
  return absolute;
}

function calcPercentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function formatJobAddress(job: RevenueWeekJob): string | null {
  const value = [job.addressLine1, job.city, job.state, job.postalCode]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(", ");
  return value.length > 0 ? value : null;
}

function analyzeWeekJobs(jobs: RevenueWeekJob[]) {
  let missingPricingCount = 0;
  let pricingMismatchCount = 0;

  for (const job of jobs) {
    const pricing = job.bookingDetails?.pricing;
    if (!pricing) {
      missingPricingCount += 1;
      continue;
    }

    const collected = job.finalTotalCents;
    const exact = job.quotedTotalCents;
    const rangeMin = pricing.rangeMinCents ?? null;
    const rangeMax = pricing.rangeMaxCents ?? null;

    if (pricing.mode === "exact") {
      if (exact == null) {
        missingPricingCount += 1;
      } else if (exact !== collected) {
        pricingMismatchCount += 1;
      }
      continue;
    }

    if (pricing.mode === "range") {
      if (rangeMin == null || rangeMax == null) {
        missingPricingCount += 1;
      } else if (collected < rangeMin || collected > rangeMax) {
        pricingMismatchCount += 1;
      }
      continue;
    }

    const hasExact = exact != null;
    const hasRange = rangeMin != null && rangeMax != null;
    if (!hasExact && !hasRange) {
      missingPricingCount += 1;
      continue;
    }

    if (hasExact && exact !== collected) {
      pricingMismatchCount += 1;
      continue;
    }

    if (
      hasRange &&
      typeof rangeMin === "number" &&
      typeof rangeMax === "number" &&
      (collected < rangeMin || collected > rangeMax)
    ) {
      pricingMismatchCount += 1;
    }
  }

  return {
    missingPricingCount,
    pricingMismatchCount,
  };
}

export async function OwnerSection({ ownerView }: { ownerView?: string }): Promise<React.ReactElement> {
  const activeOwnerView = normalizeOwnerView(ownerView);
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
      callAdminApi("/api/admin/expenses?limit=8"),
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

  let commissionSummary: CommissionSummaryPayload | null = null;
  let commissionError: string | null = null;
  try {
    const res = await callAdminApi("/api/admin/commissions/summary");
    if (res.ok) {
      commissionSummary = (await res.json()) as CommissionSummaryPayload;
    } else if (res.status === 503) {
      commissionError =
        "Commissions are still initializing. Try again in a minute.";
    } else {
      commissionError = `Commissions unavailable (HTTP ${res.status})`;
    }
  } catch {
    commissionError = "Commissions unavailable.";
  }

  const weekJobInsights = revenue?.ok
    ? analyzeWeekJobs(revenue.windows.weekToDate.jobs)
    : { missingPricingCount: 0, pricingMismatchCount: 0 };
  const weekRevenue = revenue?.ok ? revenue.windows.weekToDate.totalCents : 0;
  const samePaceLastWeekRevenue = revenue?.ok
    ? revenue.windows.samePaceLastWeek.totalCents
    : 0;
  const fullLastWeekRevenue = revenue?.ok
    ? revenue.windows.fullLastWeek.totalCents
    : 0;
  const weekRevenueDelta = weekRevenue - samePaceLastWeekRevenue;
  const weekRevenueDeltaPercent = revenue?.ok
    ? calcPercentChange(weekRevenue, samePaceLastWeekRevenue)
    : null;
  const weekExpenses = expensesSummary?.ok
    ? expensesSummary.windows.weekToDate.totalCents
    : 0;
  const weekPayroll = commissionSummary?.ok
    ? commissionSummary.totalsCents.total
    : 0;
  const weekNetAfterPayroll = weekRevenue - weekExpenses - weekPayroll;

  return (
    <section className="space-y-4">
      <header className={`${TEAM_CARD_PADDED} space-y-5`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Owner HQ</h2>
            <p className={TEAM_SECTION_SUBTITLE}>Revenue, expenses, payroll, profit, and owner tools.</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Current view</div>
            <div className="mt-1 font-semibold text-slate-900">
              {OWNER_VIEWS.find((view) => view.id === activeOwnerView)?.label ?? "Overview"}
            </div>
          </div>
        </div>

        <nav className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6" aria-label="Owner HQ sections">
          {OWNER_VIEWS.map((view) => {
            const isActive = view.id === activeOwnerView;
            return (
              <a
                key={view.id}
                href={`/team?tab=owner&ownerView=${view.id}`}
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  isActive
                    ? "border-primary-200 bg-primary-50 text-primary-900 shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-primary-200 hover:bg-slate-50"
                }`}
              >
                <span className="block text-sm font-semibold">{view.label}</span>
                <span className={`mt-1 block text-xs ${isActive ? "text-primary-700" : "text-slate-500"}`}>
                  {view.description}
                </span>
              </a>
            );
          })}
        </nav>
      </header>

      <div className={`${activeOwnerView === "overview" ? "grid" : "hidden"} gap-4 xl:grid-cols-[1.1fr,1.9fr]`}>
        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Needs attention
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Weekly issues and payout items that need a quick look.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-sm">
            {revenue?.ok ? (
              <>
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900">
                  <div className="font-semibold">
                    {weekJobInsights.missingPricingCount} jobs missing recorded
                    quote/range
                  </div>
                  <div className="mt-1 text-xs text-amber-700">
                    These jobs were completed this week but do not have clean
                    quote/range data for comparison.
                  </div>
                </div>
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-sky-900">
                  <div className="font-semibold">
                    {weekJobInsights.pricingMismatchCount} jobs collected
                    outside the recorded quote/range
                  </div>
                  <div className="mt-1 text-xs text-sky-700">
                    Good for spotting discounting, upsells, or pricing drift.
                  </div>
                </div>
              </>
            ) : null}

            {commissionSummary?.ok ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-slate-900">
                <div className="font-semibold">
                  Payroll currently owed:{" "}
                  {fmtMoney(commissionSummary.totalsCents.total, "USD")}
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  Card tips waiting with payouts:{" "}
                  {fmtMoney(commissionSummary.cardTipsCents, "USD")}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Weekly cash flow
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                What came in, what is logged out, and what is still owed this
                week.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                Collected
              </div>
              <div className="mt-2 text-xl font-semibold text-emerald-950">
                {fmtMoney(weekRevenue, "USD")}
              </div>
              {revenue?.ok ? (
                <div className="mt-1 text-xs text-emerald-800">
                  {fmtSignedMoney(weekRevenueDelta, "USD")} vs same pace last
                  week
                  {weekRevenueDeltaPercent !== null
                    ? ` (${fmtPercent(weekRevenueDeltaPercent)})`
                    : ""}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Expenses logged
              </div>
              <div className="mt-2 text-xl font-semibold text-slate-900">
                {fmtMoney(weekExpenses, "USD")}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                {expensesSummary?.ok
                  ? `${expensesSummary.windows.weekToDate.count} expenses this week`
                  : "Waiting on expense data"}
              </div>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                Payroll owed
              </div>
              <div className="mt-2 text-xl font-semibold text-amber-950">
                {fmtMoney(weekPayroll, "USD")}
              </div>
              <div className="mt-1 text-xs text-amber-800">
                Current week payout before tips
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Net after payout
              </div>
              <div
                className={`mt-2 text-xl font-semibold ${weekNetAfterPayroll >= 0 ? "text-emerald-700" : "text-rose-700"}`}
              >
                {fmtMoney(weekNetAfterPayroll, "USD")}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                Collected minus logged expenses and payroll
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`${activeOwnerView === "overview" ? "grid" : "hidden"} gap-4 lg:grid-cols-4`}>
        <a href="/team?tab=owner&ownerView=revenue" className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Revenue review</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtMoney(weekRevenue, "USD")}</div>
          <div className="mt-1 text-sm text-slate-600">
            {revenue?.ok ? `${revenue.windows.weekToDate.count} completed jobs this week` : "Revenue data unavailable"}
          </div>
        </a>
        <a href="/team?tab=owner&ownerView=expenses" className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Expense review</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{fmtMoney(weekExpenses, "USD")}</div>
          <div className="mt-1 text-sm text-slate-600">
            {expensesSummary?.ok ? `${expensesSummary.windows.weekToDate.count} expenses this week` : "Expense data unavailable"}
          </div>
        </a>
        <a href="/team?tab=owner&ownerView=payroll" className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Payroll review</div>
          <div className="mt-2 text-2xl font-semibold text-amber-800">{fmtMoney(weekPayroll, "USD")}</div>
          <div className="mt-1 text-sm text-slate-600">Current payout before card tips</div>
        </a>
        <a href="/team?tab=owner&ownerView=pl" className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">P&amp;L snapshot</div>
          <div className={`mt-2 text-2xl font-semibold ${weekNetAfterPayroll >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
            {fmtMoney(weekNetAfterPayroll, "USD")}
          </div>
          <div className="mt-1 text-sm text-slate-600">Week net after expenses and payroll</div>
        </a>
      </div>

      <div className={`${TEAM_CARD_PADDED} ${activeOwnerView === "revenue" ? "" : "hidden"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Revenue</h3>
            <p className="text-sm text-slate-600">
              Completed appointments counted from actual collected totals on
              their scheduled calendar date.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-2 text-sm text-slate-700">
          {revenueError ? (
            <p className="text-amber-700">{revenueError}</p>
          ) : revenue?.ok ? (
            <ul className="space-y-2">
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900">
                    Week to date
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.weekToDate.count} jobs
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Counting from{" "}
                    {fmtWindowStart(
                      revenue.windows.weekToDate.startsAt,
                      revenue.timezone,
                    )}
                  </div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(
                    revenue.windows.weekToDate.totalCents,
                    revenue.currency,
                  )}
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">
                    Same pace last week
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.samePaceLastWeek.count} jobs
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {fmtWindowStart(
                      revenue.windows.samePaceLastWeek.startsAt,
                      revenue.timezone,
                    )}{" "}
                    through the same point in the week
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-slate-900">
                    {fmtMoney(
                      revenue.windows.samePaceLastWeek.totalCents,
                      revenue.currency,
                    )}
                  </div>
                  <div
                    className={`text-xs ${weekRevenueDelta >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                  >
                    {fmtSignedMoney(weekRevenueDelta, revenue.currency)}
                  </div>
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">
                    Full last week
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.fullLastWeek.count} jobs
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {fmtWindowStart(
                      revenue.windows.fullLastWeek.startsAt,
                      revenue.timezone,
                    )}{" "}
                    through{" "}
                    {fmtWindowEndExclusive(
                      revenue.windows.fullLastWeek.endsAt,
                      revenue.timezone,
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-slate-900">
                    {fmtMoney(fullLastWeekRevenue, revenue.currency)}
                  </div>
                </div>
              </li>
              {revenue.windows.weekToDate.jobs.length ? (
                <li className="rounded-lg border border-slate-200 bg-white px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Completed jobs this week
                  </div>
                  <div className="mt-3 space-y-2">
                    {revenue.windows.weekToDate.jobs.map((job) => {
                      const pricingSummary =
                        formatAppointmentPricing(
                          job.bookingDetails,
                          job.quotedTotalCents,
                        ) ?? "Not recorded";
                      const addressSummary = formatJobAddress(job);
                      return (
                        <div
                          key={job.appointmentId}
                          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900">
                                {job.contactName}
                              </div>
                              <div className="text-xs text-slate-600">
                                {fmtWhen(job.startAt, revenue.timezone)}
                              </div>
                              {addressSummary ? (
                                <div className="truncate text-[11px] text-slate-500">
                                  {addressSummary}
                                </div>
                              ) : null}
                            </div>
                            <div className="text-right text-sm font-semibold text-slate-900">
                              {fmtMoney(job.finalTotalCents, revenue.currency)}
                            </div>
                          </div>
                          <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="font-semibold text-slate-500">
                                Quote / Range
                              </div>
                              <div className="mt-1 text-slate-900">
                                {pricingSummary}
                              </div>
                            </div>
                            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                              <div className="font-semibold text-slate-500">
                                Collected
                              </div>
                              <div className="mt-1 text-slate-900">
                                {formatUsdCents(job.finalTotalCents) ??
                                  fmtMoney(
                                    job.finalTotalCents,
                                    revenue.currency,
                                  )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </li>
              ) : null}
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">
                    Month to date
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.monthToDate.count} jobs
                  </div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(
                    revenue.windows.monthToDate.totalCents,
                    revenue.currency,
                  )}
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">
                    Last 30 days
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.last30Days.count} jobs
                  </div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(
                    revenue.windows.last30Days.totalCents,
                    revenue.currency,
                  )}
                </div>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-900">
                    Year to date
                  </div>
                  <div className="text-xs text-slate-600">
                    {revenue.windows.yearToDate.count} jobs
                  </div>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {fmtMoney(
                    revenue.windows.yearToDate.totalCents,
                    revenue.currency,
                  )}
                </div>
              </li>
            </ul>
          ) : (
            <p className="text-slate-600">No completed appointments yet.</p>
          )}
        </div>
      </div>

      <div className={`${activeOwnerView === "expenses" || activeOwnerView === "payroll" ? "grid" : "hidden"} gap-4`}>
        <div className={`${TEAM_CARD_PADDED} ${activeOwnerView === "expenses" ? "" : "hidden"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Expenses</h3>
              <p className="mt-1 text-sm text-slate-600">
                Ops logs daily totals in the Ops tab.
              </p>
            </div>
            <a
              href="/team?tab=expenses"
              className={teamButtonClass("primary", "sm")}
            >
              Open
            </a>
          </div>

          {expensesSummaryError ? (
            <p className="mt-3 text-sm text-amber-700">
              {expensesSummaryError}
            </p>
          ) : null}

          {expensesSummary?.ok ? (
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              {(
                [
                  {
                    label: "Month to date",
                    window: expensesSummary.windows.monthToDate,
                  },
                  {
                    label: "Last 30 days",
                    window: expensesSummary.windows.last30Days,
                  },
                  {
                    label: "Year to date",
                    window: expensesSummary.windows.yearToDate,
                  },
                ] as Array<{ label: string; window: ExpenseSummaryWindow }>
              ).map(({ label, window }) => (
                <li
                  key={label}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div>
                    <div className="font-semibold text-slate-900">{label}</div>
                    <div className="text-xs text-slate-600">
                      {window.count} expenses
                    </div>
                  </div>
                  <div className="text-right font-semibold text-slate-900">
                    {fmtMoney(window.totalCents, expensesSummary.currency)}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {expensesError ? (
            <p className="mt-3 text-sm text-amber-700">{expensesError}</p>
          ) : null}
          {recentExpenses.length ? (
            <div className="mt-4 space-y-2">
              {recentExpenses.map((expense) => (
                <div
                  key={expense.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        {fmtDay(expense.paidAt)}
                      </span>
                      {expense.category ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {expense.category}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-slate-600">
                      {[expense.vendor, expense.memo]
                        .filter(Boolean)
                        .join(" - ") || "No details"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {fmtMoney(expense.amountCents, expense.currency)}
                    </span>
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

        <div className={`${TEAM_CARD_PADDED} ${activeOwnerView === "payroll" ? "" : "hidden"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Commissions
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Weekly payout totals (settings + payouts live in Control →
                Commissions).
              </p>
            </div>
            <a
              href="/team?tab=commissions"
              className={teamButtonClass("secondary", "sm")}
            >
              Open
            </a>
          </div>

          {commissionError ? (
            <p className="mt-3 text-sm text-amber-700">{commissionError}</p>
          ) : null}

          {commissionSummary?.ok ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Current week (Mon-Sun)
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      Total:{" "}
                      {fmtMoney(commissionSummary.totalsCents.total, "USD")}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      Counting completed jobs from{" "}
                      {fmtWindowStart(
                        commissionSummary.periodStart,
                        commissionSummary.timezone,
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      Payout scheduled{" "}
                      {fmtWhen(
                        commissionSummary.scheduledPayoutAt,
                        commissionSummary.timezone,
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      Card tips tracked separately:{" "}
                      {fmtMoney(commissionSummary.cardTipsCents, "USD")}
                    </div>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <div>
                      Sales:{" "}
                      {fmtMoney(commissionSummary.totalsCents.sales, "USD")}
                    </div>
                    <div>
                      Management:{" "}
                      {fmtMoney(commissionSummary.totalsCents.marketing, "USD")}
                    </div>
                    <div>
                      Crew:{" "}
                      {fmtMoney(commissionSummary.totalsCents.crew, "USD")}
                    </div>
                    {commissionSummary.totalsCents.adjustments ? (
                      <div>
                        Adjustments:{" "}
                        {fmtMoney(
                          commissionSummary.totalsCents.adjustments,
                          "USD",
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-600">
              Commissions are calculated from completed jobs in the current
              Monday-Sunday week using final amount paid.
            </p>
          )}
        </div>
      </div>

      <div className={`${TEAM_CARD_PADDED} ${activeOwnerView === "pl" ? "" : "hidden"}`}>
        <h3 className="text-lg font-semibold text-slate-900">P&amp;L</h3>
        <p className="mt-1 text-sm text-slate-600">
          Revenue (completed jobs) minus expenses (including commission payouts
          once marked paid).
        </p>

        {revenue?.ok && expensesSummary?.ok ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {(
              [
                { key: "last30Days", label: "Last 30 days" },
                { key: "monthToDate", label: "Month to date" },
                { key: "yearToDate", label: "Year to date" },
              ] as const
            ).map(({ key, label }) => {
              const rev = revenue.windows[key].totalCents ?? 0;
              const exp = expensesSummary.windows[key].totalCents ?? 0;
              const profit = rev - exp;
              const margin = rev > 0 ? (profit / rev) * 100 : 0;

              return (
                <div
                  key={key}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {label}
                  </div>
                  <div className="mt-2 space-y-1 text-sm text-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">Revenue</span>
                      <span className="font-semibold text-slate-900">
                        {fmtMoney(rev, "USD")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">Expenses</span>
                      <span className="font-semibold text-slate-900">
                        {fmtMoney(exp, "USD")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-2">
                      <span className="text-slate-600">Profit</span>
                      <span
                        className={`font-semibold ${profit >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                      >
                        {fmtMoney(profit, "USD")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span>Margin</span>
                      <span>{fmtPercent(margin)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-600">
            {revenueError ||
              expensesSummaryError ||
              "P&L unavailable right now."}
          </p>
        )}
      </div>

      {activeOwnerView === "assistant" ? <OwnerAssistClient /> : null}
    </section>
  );
}
