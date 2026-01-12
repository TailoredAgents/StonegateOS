import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

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

export async function CommissionsSection(): Promise<React.ReactElement> {
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

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Commissions</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Weekly payouts calculated from completed jobs using final amount paid. Sales is assigned on each contact,
          marketing is paid to the marketing recipient, and crews are selected when marking a job complete.
        </p>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Payout runs</h3>
            <p className="mt-1 text-sm text-slate-600">Create, lock, and mark payouts as paid.</p>
          </div>
          <form action="/api/team/commissions/payout-runs" method="post">
            <input type="hidden" name="action" value="create" />
            <SubmitButton className={teamButtonClass("primary")} pendingLabel="Creating...">
              Create this week&apos;s payout
            </SubmitButton>
          </form>
        </div>

        {commissionError ? <p className="mt-3 text-sm text-amber-700">{commissionError}</p> : null}

        <div className="mt-5 space-y-3">
          {payoutRuns.length === 0 ? (
            <p className="text-sm text-slate-600">No payout runs yet.</p>
          ) : (
            payoutRuns.map((run) => (
              <div key={run.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">
                      {run.status.toUpperCase()} — {fmtMoney(run.totalCents, "USD")}
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
                        <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Locking...">
                          Lock
                        </SubmitButton>
                      </form>
                    ) : null}
                    {run.status !== "draft" ? (
                      <a
                        href={`/api/team/commissions/payout-runs/${run.id}/export`}
                        className={teamButtonClass("secondary", "sm")}
                      >
                        Export CSV
                      </a>
                    ) : null}
                    {run.status === "locked" ? (
                      <form action="/api/team/commissions/payout-runs" method="post">
                        <input type="hidden" name="action" value="paid" />
                        <input type="hidden" name="payoutRunId" value={run.id} />
                        <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
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

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">Settings</h3>
        <p className="mt-1 text-sm text-slate-600">Update the commission split percentages and marketing recipient.</p>

        {commissionSettings ? (
          <form
            action="/api/team/commissions/settings"
            method="post"
            className="mt-4 grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700 sm:grid-cols-2"
          >
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
                <option value="">(Select)</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <SubmitButton className={teamButtonClass("secondary")} pendingLabel="Saving...">
                Save commission settings
              </SubmitButton>
            </div>
          </form>
        ) : (
          <p className="mt-3 text-sm text-slate-600">Commission settings not available yet.</p>
        )}
      </div>
    </section>
  );
}

