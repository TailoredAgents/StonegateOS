import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { callAdminApi } from "../lib/api";

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

export async function OwnerSection(): Promise<React.ReactElement> {
  let revenue: RevenuePayload | null = null;
  let revenueError: string | null = null;
  try {
    const res = await callAdminApi("/api/revenue/summary");
    if (res.ok) {
      const payload = (await res.json()) as RevenuePayload;
      revenue = payload;
    } else {
      revenueError = `Revenue unavailable (HTTP ${res.status})`;
    }
  } catch (error) {
    revenueError = "Revenue unavailable.";
  }

  function fmtMoney(cents: number, currency: string) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Owner HQ</h2>
            <p className="text-sm text-slate-600">
              Ask about revenue, payments, schedule, or projections. Answers are grounded in live data when available.
            </p>
          </div>
        </div>
      </div>

      <OwnerAssistClient />

      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Revenue</h3>
            <p className="text-sm text-slate-600">
              Completed appointments (final total when set, otherwise quoted).
            </p>
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
        <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
          <h3 className="text-lg font-semibold text-slate-900">Expenses</h3>
          <p className="text-sm text-slate-600">
            Expenses tracking isn&apos;t connected yet. Add expense data to see spend and savings opportunities here.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
          <h3 className="text-lg font-semibold text-slate-900">P&amp;L</h3>
          <p className="text-sm text-slate-600">
            Monthly and yearly P&amp;L will appear once expenses are connected. Revenue now comes from completed appointments.
          </p>
        </div>
      </div>
    </section>
  );
}
