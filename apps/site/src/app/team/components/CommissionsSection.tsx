import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

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
  reimbursementTotalCents: number;
  otherAdjustmentsTotalCents: number;
  adjustments: PayoutRunAdjustment[];
};

type PayoutRunAdjustment = {
  id: string;
  memberId: string | null;
  memberName: string | null;
  kind: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
  expense:
    | {
        id: string;
        paidAt: string;
        category: string | null;
        vendor: string | null;
        memo: string | null;
        receipt: { filename: string; contentType: string } | null;
      }
    | null;
};

type PayoutRunsPayload = {
  ok: true;
  payoutRuns: PayoutRun[];
};

type CrewPoolOverrideDay = {
  id: string;
  localDate: string;
  timezone: string;
  crewPoolRateBps: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

type CrewPoolOverrideDaysPayload = {
  ok: true;
  timezone: string;
  overrides: CrewPoolOverrideDay[];
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
    minute: "2-digit",
  }).format(d);
}

function fmtLocalDate(localDate: string, timezone: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function fmtDay(iso: string, timezone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function todayDateInput(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function CommissionsSection(): Promise<React.ReactElement> {
  let commissionSettings: CommissionSettings | null = null;
  let commissionError: string | null = null;
  let payoutRuns: PayoutRun[] = [];
  let members: TeamMemberLite[] = [];
  let crewPoolOverrideDays: CrewPoolOverrideDay[] = [];
  let overrideDaysTimeZone = "America/New_York";
  let overrideError: string | null = null;

  try {
    const [settingsRes, runsRes, membersRes, overridesRes] = await Promise.all([
      callAdminApi("/api/admin/commissions/settings"),
      callAdminApi("/api/admin/commissions/payout-runs?limit=10"),
      callAdminApi("/api/admin/team/members"),
      callAdminApi("/api/admin/commissions/crew-pool-overrides"),
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

    if (overridesRes.ok) {
      const payload =
        (await overridesRes.json()) as CrewPoolOverrideDaysPayload;
      crewPoolOverrideDays = payload.overrides ?? [];
      overrideDaysTimeZone = payload.timezone ?? overrideDaysTimeZone;
    } else {
      overrideError = `Labor override days unavailable (HTTP ${overridesRes.status})`;
    }
  } catch {
    commissionError = commissionError ?? "Commission settings unavailable.";
    overrideError = overrideError ?? "Labor override days unavailable.";
  }

  const defaultReimbursementDate = todayDateInput(
    commissionSettings?.timezone ?? "America/New_York",
  );

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>Commissions</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Weekly payouts use the current Monday-Sunday week and final amount
          paid. Sales commission is retired for new calculations, management
          pays Jeffrey and Austin 7.5% each, and labor stays at 22.5% of the job
          total regardless of the crew.
        </p>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Payout runs
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Create, lock, and mark payouts as paid.
            </p>
          </div>
          <form action="/api/team/commissions/payout-runs" method="post">
            <input type="hidden" name="action" value="create" />
            <SubmitButton
              className={teamButtonClass("primary")}
              pendingLabel="Creating..."
            >
              Create this week&apos;s payout
            </SubmitButton>
          </form>
        </div>

        {commissionError ? (
          <p className="mt-3 text-sm text-amber-700">{commissionError}</p>
        ) : null}

        <div className="mt-5 space-y-3">
          {payoutRuns.length === 0 ? (
            <p className="text-sm text-slate-600">No payout runs yet.</p>
          ) : (
            payoutRuns.map((run) => {
              const reimbursements = run.adjustments.filter(
                (adjustment) => adjustment.kind === "reimbursement",
              );
              const otherAdjustments = run.adjustments.filter(
                (adjustment) => adjustment.kind !== "reimbursement",
              );

              return (
                <div
                  key={run.id}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">
                        {run.status.toUpperCase()} — {fmtMoney(run.totalCents, "USD")}
                      </div>
                      <div className="text-xs text-slate-600">
                        Period: {fmtWhen(run.periodStart, run.timezone)} →{" "}
                        {fmtWhen(run.periodEnd, run.timezone)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-full bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">
                          Reimbursements {fmtMoney(run.reimbursementTotalCents, "USD")}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-600">
                          Other adjustments {fmtMoney(run.otherAdjustmentsTotalCents, "USD")}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/api/team/commissions/payout-runs/${run.id}/report`}
                        target="_blank"
                        rel="noreferrer"
                        className={teamButtonClass("secondary", "sm")}
                      >
                        Print HTML
                      </a>
                      {run.status === "draft" ? (
                        <form
                          action="/api/team/commissions/payout-runs"
                          method="post"
                        >
                          <input type="hidden" name="action" value="lock" />
                          <input
                            type="hidden"
                            name="payoutRunId"
                            value={run.id}
                          />
                          <SubmitButton
                            className={teamButtonClass("secondary", "sm")}
                            pendingLabel="Locking..."
                          >
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
                        <form
                          action="/api/team/commissions/payout-runs"
                          method="post"
                        >
                          <input type="hidden" name="action" value="paid" />
                          <input
                            type="hidden"
                            name="payoutRunId"
                            value={run.id}
                          />
                          <SubmitButton
                            className={teamButtonClass("primary", "sm")}
                            pendingLabel="Saving..."
                          >
                            Mark Paid
                          </SubmitButton>
                        </form>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="text-base font-semibold text-slate-900">
                            Reimbursements
                          </h4>
                          <p className="mt-1 text-xs text-slate-600">
                            Use this when someone paid out of pocket for
                            company supplies or tools. It adds to that
                            person&apos;s payout and logs the business expense
                            with the receipt.
                          </p>
                        </div>
                        <div className="text-right text-xs text-slate-600">
                          <div>{reimbursements.length} items</div>
                          <div className="font-semibold text-slate-900">
                            {fmtMoney(run.reimbursementTotalCents, "USD")}
                          </div>
                        </div>
                      </div>

                      {run.status === "draft" ? (
                        <form
                          action={`/api/team/commissions/payout-runs/${run.id}/reimbursements`}
                          method="post"
                          encType="multipart/form-data"
                          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
                        >
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-slate-600">
                              Team member
                            </span>
                            <select
                              name="memberId"
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                              required
                            >
                              <option value="">(Select)</option>
                              {members.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-slate-600">
                              Amount
                            </span>
                            <input
                              name="amount"
                              inputMode="decimal"
                              placeholder="e.g. 299.00"
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                              required
                            />
                          </label>
                          <label className="flex flex-col gap-1 sm:col-span-2">
                            <span className="text-xs font-medium text-slate-600">
                              What was purchased
                            </span>
                            <input
                              name="note"
                              placeholder="Milwaukee rapid charger + 12.0 battery"
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                              required
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-slate-600">
                              Vendor (optional)
                            </span>
                            <input
                              name="vendor"
                              placeholder="Home Depot"
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-slate-600">
                              Purchase date
                            </span>
                            <input
                              name="paidDate"
                              type="date"
                              defaultValue={defaultReimbursementDate}
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                              required
                            />
                          </label>
                          <label className="flex flex-col gap-1 sm:col-span-2">
                            <span className="text-xs font-medium text-slate-600">
                              Receipt photo (optional)
                            </span>
                            <input
                              name="receiptFile"
                              type="file"
                              accept="image/*"
                              className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                            />
                            <span className="text-[11px] text-slate-500">
                              Max 10MB.
                            </span>
                          </label>
                          <div className="sm:col-span-2">
                            <SubmitButton
                              className={teamButtonClass("primary")}
                              pendingLabel="Saving..."
                            >
                              Add reimbursement
                            </SubmitButton>
                          </div>
                        </form>
                      ) : (
                        <p className="mt-4 text-xs text-slate-600">
                          Reimbursements are locked once the payout run is
                          locked.
                        </p>
                      )}

                      {otherAdjustments.length > 0 ? (
                        <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-3 py-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Other adjustments
                          </div>
                          <div className="mt-2 space-y-2">
                            {otherAdjustments.map((adjustment) => (
                              <div
                                key={adjustment.id}
                                className="flex items-start justify-between gap-3 text-xs text-slate-600"
                              >
                                <div>
                                  <div className="font-medium text-slate-900">
                                    {adjustment.memberName ?? "Unknown member"}
                                  </div>
                                  <div>
                                    {adjustment.note?.trim() ||
                                      "Manual adjustment"}
                                  </div>
                                </div>
                                <div className="font-semibold text-slate-900">
                                  {fmtMoney(adjustment.amountCents, "USD")}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-base font-semibold text-slate-900">
                          Current reimbursement list
                        </h4>
                        <div className="text-xs text-slate-500">
                          {reimbursements.length === 0
                            ? "Nothing added yet"
                            : `${reimbursements.length} saved`}
                        </div>
                      </div>

                      {reimbursements.length === 0 ? (
                        <p className="mt-3 text-sm text-slate-600">
                          Add out-of-pocket purchases here so they land in the
                          right payout and stay attached to the receipt.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {reimbursements.map((adjustment) => (
                            <div
                              key={adjustment.id}
                              className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-semibold text-slate-900">
                                    {adjustment.memberName ?? "Unknown member"}
                                  </div>
                                  <div className="mt-1 text-sm text-slate-700">
                                    {adjustment.note?.trim() ||
                                      adjustment.expense?.memo?.trim() ||
                                      "Reimbursement"}
                                  </div>
                                  <div className="mt-1 text-xs text-slate-500">
                                    {fmtDay(
                                      adjustment.expense?.paidAt ??
                                        adjustment.createdAt,
                                      run.timezone,
                                    )}
                                    {adjustment.expense?.vendor
                                      ? ` • ${adjustment.expense.vendor}`
                                      : ""}
                                  </div>
                                  {adjustment.expense?.receipt ? (
                                    <a
                                      href={`/api/team/expenses/${encodeURIComponent(adjustment.expense.id)}/receipt`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="mt-2 inline-flex text-xs font-semibold text-primary-700 underline-offset-2 hover:underline"
                                    >
                                      View receipt
                                    </a>
                                  ) : null}
                                </div>
                                <div className="text-right">
                                  <div className="font-semibold text-slate-900">
                                    {fmtMoney(adjustment.amountCents, "USD")}
                                  </div>
                                  {run.status === "draft" ? (
                                    <form
                                      action={`/api/team/commissions/payout-runs/${run.id}/reimbursements`}
                                      method="post"
                                      className="mt-2"
                                    >
                                      <input
                                        type="hidden"
                                        name="action"
                                        value="delete"
                                      />
                                      <input
                                        type="hidden"
                                        name="adjustmentId"
                                        value={adjustment.id}
                                      />
                                      <SubmitButton
                                        className={teamButtonClass(
                                          "secondary",
                                          "sm",
                                        )}
                                        pendingLabel="Removing..."
                                      >
                                        Remove
                                      </SubmitButton>
                                    </form>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">Settings</h3>
        <p className="mt-1 text-sm text-slate-600">
          Sales, management, and labor rates are fixed under the current
          commission structure.
        </p>

        {commissionSettings ? (
          <div
            className="mt-4 grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700 sm:grid-cols-2"
          >
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <div className="text-xs font-medium text-slate-600">Sales</div>
              <div className="mt-1 text-base font-semibold text-slate-900">
                Retired
              </div>
              <div className="mt-1 text-xs text-slate-500">
                No new sales commission is generated.
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <div className="text-xs font-medium text-slate-600">
                Management
              </div>
              <div className="mt-1 text-base font-semibold text-slate-900">
                15% total
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Split 7.5% to Jeffrey and 7.5% to Austin.
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <span className="text-xs font-medium text-slate-600">
                Labor pool
              </span>
              <div className="mt-1 text-base font-semibold text-slate-900">
                {fmtPercent(commissionSettings.crewPoolRateBps)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Fixed for every completed job.
              </div>
            </div>
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-3">
              <div className="text-xs font-medium text-slate-600">
                Locked labor splits
              </div>
              <div className="mt-1 text-sm text-slate-700">
                All crew combinations split the 22.5% labor pool evenly.
              </div>
              <div className="mt-1 text-sm text-slate-700">
                Jeffrey + Austin + Devon: 7.5% each
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Two-person crews receive 11.25% each.
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-600">
            Commission settings not available yet.
          </p>
        )}
      </div>

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-lg font-semibold text-slate-900">
          Labor override days
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Retired. Labor now stays at 22.5% for every completed job, so saved
          override days are ignored by new commission calculations.
        </p>

        {overrideError ? (
          <p className="mt-3 text-sm text-amber-700">{overrideError}</p>
        ) : null}

        <div className="mt-4 space-y-2">
          {crewPoolOverrideDays.length === 0 ? (
            <p className="text-sm text-slate-600">
              No labor override days saved yet.
            </p>
          ) : (
            crewPoolOverrideDays.map((override) => (
              <div
                key={override.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900">
                    {fmtLocalDate(override.localDate, overrideDaysTimeZone)}
                  </div>
                  <div className="text-xs text-slate-600">
                    Retired {fmtPercent(override.crewPoolRateBps)} override
                  </div>
                  {override.note ? (
                    <div className="mt-1 text-[11px] text-slate-500">
                      {override.note}
                    </div>
                  ) : null}
                </div>
                <div className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Ignored
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
