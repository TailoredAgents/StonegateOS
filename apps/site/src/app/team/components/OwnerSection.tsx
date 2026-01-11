import React from "react";
import { OwnerAssistClient } from "./OwnerAssistClient";
import { SubmitButton } from "@/components/SubmitButton";
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

type CommissionSettings = {
  key: string;
  timezone: string;
  payoutWeekday: number;
  payoutHour: number;
  payoutMinute: number;
  salesRateBps: number;
  marketingRateBps: number;
  crewPoolRateBps: number;
  marketingMemberId: string | null;
};

type CommissionSettingsPayload = {
  ok: true;
  settings: CommissionSettings;
};

type TeamMemberLite = {
  id: string;
  name: string;
  active: boolean;
};

type TeamMembersPayload = {
  members?: Array<TeamMemberLite & { role?: { slug?: string | null } | null }>;
};

type PayoutRun = {
  id: string;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  scheduledPayoutAt: string;
  status: "draft" | "locked" | "paid";
  createdAt: string;
  lockedAt: string | null;
  paidAt: string | null;
  totalCents: number;
};

type PayoutRunsPayload = {
  ok: true;
  payoutRuns: PayoutRun[];
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

  let commissionSettings: CommissionSettings | null = null;
  let commissionError: string | null = null;
  let payoutRuns: PayoutRun[] = [];
  let members: TeamMemberLite[] = [];

  try {
    const [settingsRes, runsRes, membersRes] = await Promise.all([
      callAdminApi("/api/admin/commissions/settings"),
      callAdminApi("/api/admin/commissions/payout-runs?limit=10"),
      callAdminApi("/api/admin/team/members")
    ]);

    if (settingsRes.ok) {
      const payload = (await settingsRes.json()) as CommissionSettingsPayload;
      commissionSettings = payload.settings;
    } else {
      commissionError = `Commission settings unavailable (HTTP ${settingsRes.status})`;
    }

    if (runsRes.ok) {
      const payload = (await runsRes.json()) as PayoutRunsPayload;
      payoutRuns = payload.payoutRuns ?? [];
    }

    if (membersRes.ok) {
      const payload = (await membersRes.json()) as TeamMembersPayload;
      members = (payload.members ?? [])
        .filter((m) => m.active)
        .map((m) => ({ id: m.id, name: m.name, active: m.active }));
    }
  } catch {
    commissionError = commissionError ?? "Commission settings unavailable.";
  }

  function fmtMoney(cents: number, currency: string) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  }

  function fmtPercent(bps: number): string {
    return String((bps / 100).toFixed(2)).replace(/\.00$/, "");
  }

  function fmtWhen(iso: string, timezone: string): string {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(d);
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

      <div className="rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-lg shadow-slate-200/60">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Commissions</h3>
            <p className="text-sm text-slate-600">
              Calculated from completed jobs using final amount paid. Weekly payouts run Friday 12:00 PM (America/New_York).
            </p>
          </div>
          <form action="/api/team/commissions/payout-runs" method="post">
            <input type="hidden" name="action" value="create" />
            <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Creating...">
              Create this week&apos;s payout
            </SubmitButton>
          </form>
        </div>

        {commissionError ? <p className="mt-3 text-sm text-amber-700">{commissionError}</p> : null}

        {commissionSettings ? (
          <form action="/api/team/commissions/settings" method="post" className="mt-4 grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Sales %</span>
              <input
                name="salesRatePercent"
                defaultValue={fmtPercent(commissionSettings.salesRateBps)}
                inputMode="decimal"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Marketing %</span>
              <input
                name="marketingRatePercent"
                defaultValue={fmtPercent(commissionSettings.marketingRateBps)}
                inputMode="decimal"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Crew pool %</span>
              <input
                name="crewPoolRatePercent"
                defaultValue={fmtPercent(commissionSettings.crewPoolRateBps)}
                inputMode="decimal"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">Marketing recipient</span>
              <select
                name="marketingMemberId"
                defaultValue={commissionSettings.marketingMemberId ?? ""}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2"
              >
                <option value="">(Not set)</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <SubmitButton className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-primary-300 hover:text-primary-700" pendingLabel="Saving...">
                Save commission settings
              </SubmitButton>
            </div>
          </form>
        ) : null}

        <div className="mt-5 space-y-3">
          {payoutRuns.length === 0 ? (
            <p className="text-sm text-slate-600">No payout runs yet.</p>
          ) : (
            payoutRuns.map((run) => (
              <div key={run.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">
                      {run.status.toUpperCase()} • {fmtMoney(run.totalCents, "USD")}
                    </div>
                    <div className="text-xs text-slate-600">
                      Period: {fmtWhen(run.periodStart, run.timezone)} → {fmtWhen(run.periodEnd, run.timezone)}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {run.status === "draft" ? (
                      <form action="/api/team/commissions/payout-runs" method="post">
                        <input type="hidden" name="action" value="lock" />
                        <input type="hidden" name="payoutRunId" value={run.id} />
                        <SubmitButton className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:border-primary-300 hover:text-primary-700" pendingLabel="Locking...">
                          Lock
                        </SubmitButton>
                      </form>
                    ) : null}
                    {run.status !== "draft" ? (
                      <a
                        href={`/api/team/commissions/payout-runs/${run.id}/export`}
                        className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:border-primary-300 hover:text-primary-700"
                      >
                        Export CSV
                      </a>
                    ) : null}
                    {run.status === "locked" ? (
                      <form action="/api/team/commissions/payout-runs" method="post">
                        <input type="hidden" name="action" value="paid" />
                        <input type="hidden" name="payoutRunId" value={run.id} />
                        <SubmitButton className="rounded-full bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-primary-700" pendingLabel="Saving...">
                          Mark Paid
                        </SubmitButton>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
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
