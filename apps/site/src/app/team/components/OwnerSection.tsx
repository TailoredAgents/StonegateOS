import React from "react";
import Link from "next/link";
import {
  requireCurrentTeamPrincipal,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import type {
  PaymentReconciliationAppointment,
  PaymentReconciliationPayload,
} from "./PaymentReconciliationPanel";
import { callAdminApiAs } from "../lib/api";
import { teamSurfaceHref } from "../surface-registry";
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
import {
  OWNER_VIEWS,
  normalizeOwnerView,
  ownerReviewLevel,
  ownerViewNeeds,
  type OwnerDataSource,
  type OwnerReviewLevel,
} from "./owner-view";

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
  paymentLedger?: {
    scope: "all_time";
    paymentsCollectedCents: number;
    paidTowardJobsCents: number;
    tipsCollectedCents: number;
    outstandingBalanceCents: number;
    refundedCents: number;
    needsReviewCents: number;
    needsReviewCount: number;
  } | null;
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
    allTime: RevenueWindow;
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

type PayrollSummaryMember = {
  memberId: string | null;
  memberName: string;
  currentPayrollCents: number;
  currentReimbursementCents: number;
  currentTotalPayoutCents: number;
  currentSalesCents: number;
  currentManagementCents: number;
  currentCrewCents: number;
  currentOtherAdjustmentsCents: number;
  monthPayrollCents: number;
  monthReimbursementCents: number;
  monthTotalPayoutCents: number;
  yearPayrollCents: number;
  yearReimbursementCents: number;
  yearTotalPayoutCents: number;
};

type PayrollSummaryMonth = {
  month: string;
  label: string;
  payrollCents: number;
  reimbursementCents: number;
  totalPayoutCents: number;
};

type PayrollSummaryPayload = {
  ok: true;
  timezone: string;
  year: number;
  month: number;
  monthLabel: string;
  currentPeriod: {
    periodStart: string;
    periodEnd: string;
    scheduledPayoutAt: string;
  };
  totals: {
    currentPayrollCents: number;
    currentReimbursementCents: number;
    currentTotalPayoutCents: number;
    monthPayrollCents: number;
    monthReimbursementCents: number;
    monthTotalPayoutCents: number;
    yearPayrollCents: number;
    yearReimbursementCents: number;
    yearTotalPayoutCents: number;
  };
  members: PayrollSummaryMember[];
  monthly: PayrollSummaryMonth[];
};

type BookingSourceKey =
  | "facebook"
  | "google"
  | "referral"
  | "team_member"
  | "website"
  | "other"
  | "unknown";

type BookingSourceSummaryBucket = {
  source: BookingSourceKey;
  label: string;
  count: number;
  estimatedRevenueCents: number;
};

type BookingSourceSummaryJob = {
  id: string;
  contactId: string;
  source: BookingSourceKey;
  sourceLabel: string;
  attributionReason: string;
  status: string;
  appointmentType: string;
  createdAt: string;
  startAt: string | null;
  contactName: string;
  address: string | null;
  estimatedRevenueCents: number;
};

type BookingSourceSummaryPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  through: string;
  countedStatuses: string[];
  excludedAppointmentTypes: string[];
  totalBookedJobs: number;
  sources: BookingSourceSummaryBucket[];
  facebook: BookingSourceSummaryBucket;
  google: BookingSourceSummaryBucket;
  highlightedJobs: BookingSourceSummaryJob[];
  recentJobs: BookingSourceSummaryJob[];
};

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

function fmtCompactDateTime(
  iso: string,
  timezone = "America/New_York",
): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
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

    const finalTotal = job.finalTotalCents;
    const exact = job.quotedTotalCents;
    const rangeMin = pricing.rangeMinCents ?? null;
    const rangeMax = pricing.rangeMaxCents ?? null;

    if (pricing.mode === "exact") {
      if (exact == null) {
        missingPricingCount += 1;
      } else if (exact !== finalTotal) {
        pricingMismatchCount += 1;
      }
      continue;
    }

    if (pricing.mode === "range") {
      if (rangeMin == null || rangeMax == null) {
        missingPricingCount += 1;
      } else if (finalTotal < rangeMin || finalTotal > rangeMax) {
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

    if (hasExact && exact !== finalTotal) {
      pricingMismatchCount += 1;
      continue;
    }

    if (
      hasRange &&
      typeof rangeMin === "number" &&
      typeof rangeMax === "number" &&
      (finalTotal < rangeMin || finalTotal > rangeMax)
    ) {
      pricingMismatchCount += 1;
    }
  }

  return {
    missingPricingCount,
    pricingMismatchCount,
  };
}

type OwnerResourceResult<T> = {
  data: T | null;
  error: string | null;
  fetchedAt: string | null;
};

type OwnerSourceState = {
  source: OwnerDataSource;
  available: boolean;
  detail: string;
};

const OWNER_SOURCE_LABELS: Readonly<Record<OwnerDataSource, string>> = {
  revenue: "Completed appointments and final job totals",
  expense_summary: "Posted expense ledger summary",
  expense_list: "Recent expense ledger entries",
  commission_summary: "Current commission projection",
  payroll_history: "Locked and paid payroll history",
  booking_sources: "Appointment booking attribution",
  payment_reconciliation: "Payment, refund, and provider-event ledger",
  appointment_directory: "Appointment reconciliation directory",
};

function notRequested<T>(): OwnerResourceResult<T> {
  return { data: null, error: null, fetchedAt: null };
}

async function loadOwnerResource<T>(
  principal: TeamRequestPrincipal,
  path: string,
  label: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<OwnerResourceResult<T>> {
  try {
    const response = await callAdminApiAs(principal, path, init);
    const fetchedAt = new Date().toISOString();
    if (!response.ok) {
      return {
        data: null,
        error: `${label} unavailable (HTTP ${response.status}).`,
        fetchedAt,
      };
    }
    return {
      data: (await response.json()) as T,
      error: null,
      fetchedAt,
    };
  } catch {
    return {
      data: null,
      error: `${label} is temporarily unavailable.`,
      fetchedAt: new Date().toISOString(),
    };
  }
}

function latestFetchedAt(
  results: ReadonlyArray<OwnerResourceResult<unknown>>,
): string | null {
  return (
    results
      .map((result) => result.fetchedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
}

function reviewToneClasses(level: OwnerReviewLevel): string {
  if (level === "critical") {
    return "border-rose-300 bg-rose-50 text-rose-950 ring-1 ring-rose-200";
  }
  if (level === "attention") {
    return "border-amber-300 bg-amber-50 text-amber-950 ring-1 ring-amber-200";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-950";
}

function OwnerSourceStatus({
  fetchedAt,
  sources,
  onDemand = false,
}: {
  fetchedAt: string | null;
  sources: OwnerSourceState[];
  onDemand?: boolean;
}): React.ReactElement {
  const unavailable = sources.filter((source) => !source.available);
  return (
    <aside
      className={`rounded-2xl border px-4 py-3 text-sm ${
        unavailable.length > 0
          ? "border-amber-300 bg-amber-50 text-amber-950"
          : "border-slate-200 bg-slate-50 text-slate-700"
      }`}
      aria-label="Owner data sources and freshness"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">
          {onDemand ? "Data loads on request" : "Current data snapshot"}
        </div>
        <div className="text-xs">
          {fetchedAt
            ? `Checked ${fmtCompactDateTime(fetchedAt)}`
            : "No dashboard sources fetched"}
        </div>
      </div>
      {onDemand ? (
        <p className="mt-1 text-xs">
          Opening Assistant does not preload financial data. Sources are
          requested only after an owner submits a question.
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {sources.map((source) => (
              <li
                key={source.source}
                className={`rounded-full border px-2.5 py-1 font-semibold ${
                  source.available
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-rose-200 bg-rose-50 text-rose-800"
                }`}
                title={source.detail}
              >
                {OWNER_SOURCE_LABELS[source.source]} ·{" "}
                {source.available ? "Available" : "Unavailable"}
                <span className="sr-only">. {source.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Snapshot time is when Owner HQ fetched the local system of record;
            upstream-provider freshness is shown separately when available.
          </p>
          {unavailable.length > 0 ? (
            <div className="mt-2" role="alert">
              <p className="font-semibold">
                Review required: unavailable sources are not treated as $0.
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
                {unavailable.map((source) => (
                  <li key={source.source}>{source.detail}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

export async function OwnerSection({
  ownerView,
}: {
  ownerView?: string;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const activeOwnerView = normalizeOwnerView(ownerView);
  type AppointmentDirectoryPayload = {
    data?: PaymentReconciliationAppointment[];
  };

  const [
    revenueResult,
    expensesSummaryResult,
    expensesListResult,
    commissionResult,
    payrollResult,
    bookingSourceResult,
    paymentResult,
    appointmentDirectoryResult,
  ] = await Promise.all([
    ownerViewNeeds(activeOwnerView, "revenue")
      ? loadOwnerResource<RevenuePayload>(
          principal,
          "/api/revenue/summary",
          "Revenue",
        )
      : Promise.resolve(notRequested<RevenuePayload>()),
    ownerViewNeeds(activeOwnerView, "expense_summary")
      ? loadOwnerResource<ExpensesSummaryPayload>(
          principal,
          "/api/admin/expenses/summary",
          "Expense summary",
        )
      : Promise.resolve(notRequested<ExpensesSummaryPayload>()),
    ownerViewNeeds(activeOwnerView, "expense_list")
      ? loadOwnerResource<ExpensesListPayload>(
          principal,
          "/api/admin/expenses?limit=8",
          "Recent expenses",
        )
      : Promise.resolve(notRequested<ExpensesListPayload>()),
    ownerViewNeeds(activeOwnerView, "commission_summary")
      ? loadOwnerResource<CommissionSummaryPayload>(
          principal,
          "/api/admin/commissions/summary",
          "Commission summary",
        )
      : Promise.resolve(notRequested<CommissionSummaryPayload>()),
    ownerViewNeeds(activeOwnerView, "payroll_history")
      ? loadOwnerResource<PayrollSummaryPayload>(
          principal,
          "/api/admin/commissions/payroll-summary",
          "Payroll history",
        )
      : Promise.resolve(notRequested<PayrollSummaryPayload>()),
    ownerViewNeeds(activeOwnerView, "booking_sources")
      ? loadOwnerResource<BookingSourceSummaryPayload>(
          principal,
          "/api/admin/appointments/source-summary?rangeDays=7",
          "Booking source summary",
        )
      : Promise.resolve(notRequested<BookingSourceSummaryPayload>()),
    ownerViewNeeds(activeOwnerView, "payment_reconciliation")
      ? loadOwnerResource<PaymentReconciliationPayload>(
          principal,
          "/api/admin/payments/reconciliation",
          "Payment reconciliation",
          { timeoutMs: 30_000 },
        )
      : Promise.resolve(notRequested<PaymentReconciliationPayload>()),
    ownerViewNeeds(activeOwnerView, "appointment_directory")
      ? loadOwnerResource<AppointmentDirectoryPayload>(
          principal,
          "/api/appointments?status=all&limit=200",
          "Appointment directory",
          { timeoutMs: 20_000 },
        )
      : Promise.resolve(notRequested<AppointmentDirectoryPayload>()),
  ]);

  const revenue = revenueResult.data;
  const revenueError = revenueResult.error;
  const expensesSummary = expensesSummaryResult.data;
  const expensesSummaryError = expensesSummaryResult.error;
  const recentExpenses = expensesListResult.data?.expenses ?? [];
  const expensesError = expensesListResult.error;
  const commissionSummary = commissionResult.data;
  const commissionError = commissionResult.error;
  const payrollSummary = payrollResult.data;
  const payrollError = payrollResult.error;
  const bookingSourceSummary = bookingSourceResult.data;
  const bookingSourceError = bookingSourceResult.error;
  const paymentReconciliation = paymentResult.data;
  const paymentReconciliationError = paymentResult.error;
  const paymentReconciliationAppointments =
    appointmentDirectoryResult.data?.data ?? [];

  let activeSubview: React.ReactElement | null = null;
  if (activeOwnerView === "payments") {
    const { PaymentReconciliationPanel } = await import(
      "./PaymentReconciliationPanel"
    );
    activeSubview = (
      <PaymentReconciliationPanel
        data={paymentReconciliation}
        error={paymentReconciliationError}
        appointments={paymentReconciliationAppointments}
      />
    );
  } else if (activeOwnerView === "assistant") {
    const { OwnerAssistClient } = await import("./OwnerAssistClient");
    activeSubview = <OwnerAssistClient />;
  }

  const sourceStates: OwnerSourceState[] = [];
  const addSourceState = (
    source: OwnerDataSource,
    result: OwnerResourceResult<unknown>,
  ) => {
    if (!ownerViewNeeds(activeOwnerView, source)) return;
    sourceStates.push({
      source,
      available: result.data !== null && result.error === null,
      detail: result.error ?? "Available from the local system of record.",
    });
  };
  addSourceState("revenue", revenueResult);
  addSourceState("expense_summary", expensesSummaryResult);
  addSourceState("expense_list", expensesListResult);
  addSourceState("commission_summary", commissionResult);
  addSourceState("payroll_history", payrollResult);
  addSourceState("booking_sources", bookingSourceResult);
  addSourceState("payment_reconciliation", paymentResult);
  addSourceState("appointment_directory", appointmentDirectoryResult);
  const snapshotFetchedAt = latestFetchedAt([
    revenueResult,
    expensesSummaryResult,
    expensesListResult,
    commissionResult,
    payrollResult,
    bookingSourceResult,
    paymentResult,
    appointmentDirectoryResult,
  ]);

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
  const operatingSnapshotAvailable = Boolean(
    revenue?.ok && expensesSummary?.ok && commissionSummary?.ok,
  );
  const missingPricingLevel = ownerReviewLevel(
    weekJobInsights.missingPricingCount,
  );
  const pricingMismatchLevel = ownerReviewLevel(
    weekJobInsights.pricingMismatchCount,
    true,
  );
  const paymentLedgerReviewLevel = ownerReviewLevel(
    Math.max(
      revenue?.paymentLedger?.needsReviewCount ?? 0,
      revenue?.paymentLedger?.needsReviewCents ? 1 : 0,
    ),
    true,
  );
  const outstandingBalanceLevel = ownerReviewLevel(
    revenue?.paymentLedger?.outstandingBalanceCents ?? 0,
  );

  return (
    <section className="space-y-4">
      <header className={`${TEAM_CARD_PADDED} space-y-5`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Owner HQ</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Revenue, expenses, payroll, profit, and owner tools.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Current view
            </div>
            <div className="mt-1 font-semibold text-slate-900">
              {OWNER_VIEWS.find((view) => view.id === activeOwnerView)?.label ??
                "Overview"}
            </div>
          </div>
        </div>

        <nav
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7"
          aria-label="Owner HQ sections"
        >
          {OWNER_VIEWS.map((view) => {
            const isActive = view.id === activeOwnerView;
            return (
              <Link
                key={view.id}
                href={teamSurfaceHref("owner", {
                  query: { ownerView: view.id },
                })}
                aria-current={isActive ? "page" : undefined}
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  isActive
                    ? "border-primary-200 bg-primary-50 text-primary-900 shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-primary-200 hover:bg-slate-50"
                }`}
              >
                <span className="block text-sm font-semibold">
                  {view.label}
                </span>
                <span
                  className={`mt-1 block text-xs ${isActive ? "text-primary-700" : "text-slate-500"}`}
                >
                  {view.description}
                </span>
              </Link>
            );
          })}
        </nav>
      </header>

      <OwnerSourceStatus
        fetchedAt={snapshotFetchedAt}
        sources={sourceStates}
        onDemand={activeOwnerView === "assistant"}
      />

      {activeOwnerView === "overview" ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[1.1fr,1.9fr]">
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
                    <div
                      className={`rounded-xl border px-3 py-3 ${reviewToneClasses(missingPricingLevel)}`}
                    >
                      <div className="font-semibold">
                        {weekJobInsights.missingPricingCount > 0
                          ? `${weekJobInsights.missingPricingCount} completed jobs need a recorded quote or range`
                          : "No completed jobs are missing a recorded quote or range"}
                      </div>
                      <div className="mt-1 text-xs opacity-80">
                        These jobs were completed this week but do not have
                        clean quote/range data for comparison.
                      </div>
                    </div>
                    <div
                      className={`rounded-xl border px-3 py-3 ${reviewToneClasses(pricingMismatchLevel)}`}
                    >
                      <div className="font-semibold">
                        {weekJobInsights.pricingMismatchCount > 0
                          ? `${weekJobInsights.pricingMismatchCount} completed jobs need pricing review`
                          : "All comparable jobs finished within their recorded quote or range"}
                      </div>
                      <div className="mt-1 text-xs opacity-80">
                        A flagged job finished outside its quote or range and
                        may reflect a discount, upsell, or pricing drift.
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
                    Weekly operating snapshot
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Completed job revenue, logged costs, and payroll for this
                    week.
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    Completed job revenue
                  </div>
                  <div className="mt-2 text-xl font-semibold text-emerald-950">
                    {revenue?.ok ? fmtMoney(weekRevenue, "USD") : "Unavailable"}
                  </div>
                  {revenue?.ok ? (
                    <div className="mt-1 text-xs text-emerald-800">
                      {fmtSignedMoney(weekRevenueDelta, "USD")} vs same pace
                      last week
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
                    {expensesSummary?.ok
                      ? fmtMoney(weekExpenses, "USD")
                      : "Unavailable"}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    {expensesSummary?.ok
                      ? `${expensesSummary.windows.weekToDate.count} expenses this week`
                      : "Expense data could not be loaded"}
                  </div>
                </div>

                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    Payroll owed
                  </div>
                  <div className="mt-2 text-xl font-semibold text-amber-950">
                    {commissionSummary?.ok
                      ? fmtMoney(weekPayroll, "USD")
                      : "Unavailable"}
                  </div>
                  <div className="mt-1 text-xs text-amber-800">
                    {commissionSummary?.ok
                      ? "Current week payout before tips"
                      : "Commission projection could not be loaded"}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Net after payout
                  </div>
                  <div
                    className={`mt-2 text-xl font-semibold ${operatingSnapshotAvailable && weekNetAfterPayroll >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                  >
                    {operatingSnapshotAvailable
                      ? fmtMoney(weekNetAfterPayroll, "USD")
                      : "Unavailable"}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Completed job revenue minus logged expenses and payroll
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <div className={TEAM_CARD_PADDED}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Booked jobs by source
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Last 7 days, counting confirmed and completed jobs.
                    Quote-only visits are excluded.
                  </p>
                </div>
                <Link
                  href={teamSurfaceHref("owner", {
                    query: { ownerView: "revenue" },
                  })}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Revenue
                </Link>
              </div>

              {bookingSourceError ? (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  {bookingSourceError}
                </div>
              ) : null}

              {bookingSourceSummary?.ok ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                        Facebook
                      </div>
                      <div className="mt-2 text-3xl font-semibold text-blue-950">
                        {bookingSourceSummary.facebook.count}
                      </div>
                      <div className="mt-1 text-xs text-blue-800">
                        {fmtMoney(
                          bookingSourceSummary.facebook.estimatedRevenueCents,
                          "USD",
                        )}{" "}
                        quoted/final totals
                      </div>
                    </div>
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        Google
                      </div>
                      <div className="mt-2 text-3xl font-semibold text-emerald-950">
                        {bookingSourceSummary.google.count}
                      </div>
                      <div className="mt-1 text-xs text-emerald-800">
                        {fmtMoney(
                          bookingSourceSummary.google.estimatedRevenueCents,
                          "USD",
                        )}{" "}
                        quoted/final totals
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        All booked
                      </div>
                      <div className="mt-2 text-3xl font-semibold text-slate-900">
                        {bookingSourceSummary.totalBookedJobs}
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        Since {fmtCompactDateTime(bookingSourceSummary.since)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {bookingSourceSummary.sources
                      .filter(
                        (source) =>
                          !["facebook", "google"].includes(source.source),
                      )
                      .filter((source) => source.count > 0)
                      .map((source) => (
                        <div
                          key={source.source}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">
                              {source.label}
                            </span>
                            <span className="text-slate-500">
                              {source.count}
                            </span>
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              ) : bookingSourceError ? null : (
                <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                  Booking source data is loading.
                </div>
              )}
            </div>

            <div className={TEAM_CARD_PADDED}>
              <h3 className="text-lg font-semibold text-slate-900">
                Recent source-attributed jobs
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Facebook and Google bookings from the same 7-day window.
              </p>
              <div className="mt-4 space-y-2">
                {bookingSourceError ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    Source-attributed jobs are unavailable right now.
                  </div>
                ) : bookingSourceSummary?.highlightedJobs.length ? (
                  bookingSourceSummary.highlightedJobs
                    .slice(0, 6)
                    .map((job) => (
                      <Link
                        key={job.id}
                        href={teamSurfaceHref("calendar", {
                          query: { contactId: job.contactId },
                        })}
                        className="block rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm transition hover:border-primary-200 hover:bg-white"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-slate-900">
                              {job.contactName}
                            </div>
                            <div className="mt-1 text-xs text-slate-600">
                              Booked {fmtCompactDateTime(job.createdAt)}
                            </div>
                            {job.address ? (
                              <div className="mt-1 truncate text-[11px] text-slate-500">
                                {job.address}
                              </div>
                            ) : null}
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                              job.source === "facebook"
                                ? "bg-blue-100 text-blue-800"
                                : "bg-emerald-100 text-emerald-800"
                            }`}
                          >
                            {job.sourceLabel}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                          <span>Via {job.attributionReason}</span>
                          <span>
                            {fmtMoney(job.estimatedRevenueCents, "USD")}
                          </span>
                        </div>
                      </Link>
                    ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    No Facebook or Google bookings in this window.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <Link
              href={teamSurfaceHref("owner", {
                query: { ownerView: "revenue" },
              })}
              className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Completed job revenue
              </div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">
                {revenue?.ok ? fmtMoney(weekRevenue, "USD") : "Unavailable"}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {revenue?.ok
                  ? `${revenue.windows.weekToDate.count} completed jobs this week`
                  : "Revenue data unavailable"}
              </div>
            </Link>
            <Link
              href={teamSurfaceHref("owner", {
                query: { ownerView: "expenses" },
              })}
              className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Expense review
              </div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">
                {expensesSummary?.ok
                  ? fmtMoney(weekExpenses, "USD")
                  : "Unavailable"}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {expensesSummary?.ok
                  ? `${expensesSummary.windows.weekToDate.count} expenses this week`
                  : "Expense data unavailable"}
              </div>
            </Link>
            <Link
              href={teamSurfaceHref("owner", {
                query: { ownerView: "payroll" },
              })}
              className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Payroll review
              </div>
              <div className="mt-2 text-2xl font-semibold text-amber-800">
                {commissionSummary?.ok
                  ? fmtMoney(weekPayroll, "USD")
                  : "Unavailable"}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {commissionSummary?.ok
                  ? "Current payout before card tips"
                  : "Commission data unavailable"}
              </div>
            </Link>
            <Link
              href={teamSurfaceHref("owner", {
                query: { ownerView: "pl" },
              })}
              className={`${TEAM_CARD_PADDED} block transition hover:border-primary-200 hover:bg-white`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                P&amp;L snapshot
              </div>
              <div
                className={`mt-2 text-2xl font-semibold ${operatingSnapshotAvailable && weekNetAfterPayroll >= 0 ? "text-emerald-700" : "text-rose-700"}`}
              >
                {operatingSnapshotAvailable
                  ? fmtMoney(weekNetAfterPayroll, "USD")
                  : "Unavailable"}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                Week net after expenses and payroll
              </div>
            </Link>
          </div>
        </>
      ) : null}

      {activeOwnerView === "payments" ? activeSubview : null}

      {activeOwnerView === "revenue" ? (
        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">
                Completed job revenue
              </h3>
              <p className="text-sm text-slate-600">
                Completed appointments counted from final job totals on their
                scheduled calendar date. Payment collection is reported
                separately.
              </p>
            </div>
          </div>
          {revenue?.paymentLedger ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  Payment ledger · All time
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  Verified money movement is shown separately from completed job
                  revenue. Tips are included in payments collected but never
                  reduce a job balance.
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                    Payments collected
                  </div>
                  <div className="mt-2 text-lg font-semibold text-emerald-950">
                    {fmtMoney(
                      revenue.paymentLedger.paymentsCollectedCents,
                      revenue.currency,
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-800">
                    Includes{" "}
                    {fmtMoney(
                      revenue.paymentLedger.tipsCollectedCents,
                      revenue.currency,
                    )}{" "}
                    in net tips
                  </div>
                </div>
                <div
                  className={`rounded-xl border px-3 py-3 ${reviewToneClasses(outstandingBalanceLevel)}`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
                    Outstanding balance
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {fmtMoney(
                      revenue.paymentLedger.outstandingBalanceCents,
                      revenue.currency,
                    )}
                  </div>
                  <div className="mt-1 text-[11px] opacity-80">
                    {revenue.paymentLedger.outstandingBalanceCents > 0
                      ? "Review unpaid final job balances"
                      : "No unpaid final job balance"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Refunded
                  </div>
                  <div className="mt-2 text-lg font-semibold text-slate-900">
                    {fmtMoney(
                      revenue.paymentLedger.refundedCents,
                      revenue.currency,
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600">
                    Recorded provider and manual refunds
                  </div>
                </div>
                <div
                  className={`rounded-xl border px-3 py-3 ${reviewToneClasses(paymentLedgerReviewLevel)}`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
                    Needs review
                  </div>
                  <div className="mt-2 text-lg font-semibold">
                    {fmtMoney(
                      revenue.paymentLedger.needsReviewCents,
                      revenue.currency,
                    )}
                  </div>
                  <div className="mt-1 text-[11px] opacity-80">
                    {revenue.paymentLedger.needsReviewCount > 0
                      ? `${revenue.paymentLedger.needsReviewCount} flagged ledger ${revenue.paymentLedger.needsReviewCount === 1 ? "item" : "items"}`
                      : "No flagged ledger items"}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <div className="mt-4 space-y-2 text-sm text-slate-700">
            {revenueError ? (
              <div
                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-rose-900"
                role="alert"
              >
                <div className="font-semibold">Revenue unavailable</div>
                <div className="mt-1 text-xs">{revenueError}</div>
              </div>
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
                                {fmtMoney(
                                  job.finalTotalCents,
                                  revenue.currency,
                                )}
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
                                  Final job total
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
                <li className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div>
                    <div className="font-semibold text-emerald-950">
                      Lifetime revenue
                    </div>
                    <div className="text-xs text-emerald-800">
                      {revenue.windows.allTime.count} completed jobs
                    </div>
                  </div>
                  <div className="text-right font-semibold text-emerald-950">
                    {fmtMoney(
                      revenue.windows.allTime.totalCents,
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
      ) : null}

      {activeOwnerView === "expenses" ? (
        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Expenses</h3>
              <p className="mt-1 text-sm text-slate-600">
                Ops logs daily totals in the Ops tab.
              </p>
            </div>
            <Link
              href={teamSurfaceHref("expenses")}
              className={teamButtonClass("primary", "sm")}
            >
              Open
            </Link>
          </div>

          {expensesSummaryError ? (
            <div
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900"
              role="alert"
            >
              <div className="font-semibold">Expense summary unavailable</div>
              <div className="mt-1 text-xs">{expensesSummaryError}</div>
            </div>
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
            <div
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900"
              role="alert"
            >
              <div className="font-semibold">Recent expenses unavailable</div>
              <div className="mt-1 text-xs">{expensesError}</div>
            </div>
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
          ) : expensesListResult.data?.ok && !expensesError ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
              No recent posted expenses were found.
            </div>
          ) : null}
        </div>
      ) : null}

      {activeOwnerView === "payroll" ? (
        <div className={TEAM_CARD_PADDED}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Payroll</h3>
              <p className="mt-1 text-sm text-slate-600">
                Monthly and yearly pay by team member. Reimbursements are shown
                separately from payroll.
              </p>
            </div>
            <Link
              href={teamSurfaceHref("commissions")}
              className={teamButtonClass("secondary", "sm")}
            >
              Open
            </Link>
          </div>

          {commissionError ? (
            <div
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900"
              role="alert"
            >
              <div className="font-semibold">
                Commission projection unavailable
              </div>
              <div className="mt-1 text-xs">{commissionError}</div>
            </div>
          ) : null}
          {payrollError ? (
            <div
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900"
              role="alert"
            >
              <div className="font-semibold">Payroll history unavailable</div>
              <div className="mt-1 text-xs">{payrollError}</div>
            </div>
          ) : null}

          {payrollSummary?.ok ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                    Current projected
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-amber-950">
                    {fmtMoney(payrollSummary.totals.currentPayrollCents, "USD")}
                  </div>
                  <div className="mt-1 text-xs text-amber-800">
                    Pays{" "}
                    {fmtWhen(
                      payrollSummary.currentPeriod.scheduledPayoutAt,
                      payrollSummary.timezone,
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {payrollSummary.monthLabel}
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">
                    {fmtMoney(payrollSummary.totals.monthPayrollCents, "USD")}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Reimbursements{" "}
                    {fmtMoney(
                      payrollSummary.totals.monthReimbursementCents,
                      "USD",
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {payrollSummary.year} YTD
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">
                    {fmtMoney(payrollSummary.totals.yearPayrollCents, "USD")}
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Reimbursements{" "}
                    {fmtMoney(
                      payrollSummary.totals.yearReimbursementCents,
                      "USD",
                    )}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Pay by person
                  </h4>
                  <p className="mt-1 text-xs text-slate-600">
                    Current is projected from completed jobs in the open payroll
                    period. Month and YTD use locked or paid payroll history.
                  </p>
                </div>
                {payrollSummary.members.length ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-4 py-3">Team member</th>
                          <th className="px-4 py-3 text-right">Current</th>
                          <th className="px-4 py-3 text-right">Month</th>
                          <th className="px-4 py-3 text-right">YTD</th>
                          <th className="px-4 py-3 text-right">
                            YTD reimburse
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {payrollSummary.members.map((member) => (
                          <tr key={member.memberId ?? member.memberName}>
                            <td className="px-4 py-3 font-semibold text-slate-900">
                              {member.memberName}
                            </td>
                            <td className="px-4 py-3 text-right text-slate-700">
                              <div className="font-semibold text-slate-900">
                                {fmtMoney(member.currentPayrollCents, "USD")}
                              </div>
                              {member.currentReimbursementCents ? (
                                <div className="text-xs text-slate-500">
                                  +{" "}
                                  {fmtMoney(
                                    member.currentReimbursementCents,
                                    "USD",
                                  )}{" "}
                                  reimburse
                                </div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                              {fmtMoney(member.monthPayrollCents, "USD")}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                              {fmtMoney(member.yearPayrollCents, "USD")}
                            </td>
                            <td className="px-4 py-3 text-right text-slate-700">
                              {fmtMoney(member.yearReimbursementCents, "USD")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="px-4 py-4 text-sm text-slate-600">
                    No payroll history yet.
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">
                      Monthly payroll history
                    </h4>
                    <p className="mt-1 text-xs text-slate-600">
                      Locked and paid payroll by scheduled payout month.
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    {payrollSummary.year}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {payrollSummary.monthly.map((month) => (
                    <div
                      key={month.month}
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold text-slate-900">
                          {month.label}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {fmtMoney(month.payrollCents, "USD")}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Reimbursements{" "}
                        {fmtMoney(month.reimbursementCents, "USD")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
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
          ) : commissionError ? null : (
            <p className="mt-4 text-sm text-slate-600">
              Commissions are calculated from completed jobs in the current
              Monday-Sunday week using the final job total.
            </p>
          )}
        </div>
      ) : null}

      {activeOwnerView === "pl" ? (
        <div className={TEAM_CARD_PADDED}>
          <h3 className="text-lg font-semibold text-slate-900">P&amp;L</h3>
          <p className="mt-1 text-sm text-slate-600">
            Completed job revenue minus expenses (including commission payouts
            once marked paid). This is not a cash-collection report.
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
                    data-owner-pl-window={key}
                    data-owner-pl-revenue-cents={rev}
                    data-owner-pl-expense-cents={exp}
                    data-owner-pl-profit-cents={profit}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {label}
                    </div>
                    <div className="mt-2 space-y-1 text-sm text-slate-700">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600">
                          Completed job revenue
                        </span>
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
            <div
              className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900"
              role="alert"
            >
              <div className="font-semibold">P&amp;L unavailable</div>
              <div className="mt-1 text-xs">
                {revenueError ||
                  expensesSummaryError ||
                  "Revenue or expense data could not be loaded. No profit value was calculated."}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {activeOwnerView === "assistant" ? activeSubview : null}
    </section>
  );
}
