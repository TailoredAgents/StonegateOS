"use client";

import React from "react";
import {
  hourlyPayoutCents,
  parseHourlyRateCents,
  parseWorkedMinutes,
  parseCrewPayoutFormData,
  type SavedCrewPayout,
} from "../lib/crew-payout-form";

type Props = {
  teamMembers: Array<{ id: string; name: string }>;
  showSplitPercentages?: boolean;
  stacked?: boolean;
  serviceType?: string | null;
  initialCrewMembers?: SavedCrewPayout[];
  theme?: "light" | "dark";
  requireHourlyInputs?: boolean;
};

const formatMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

export function CrewPayoutSelector({
  teamMembers,
  showSplitPercentages = true,
  stacked = false,
  serviceType,
  initialCrewMembers = [],
  theme = "light",
  requireHourlyInputs = true,
}: Props): React.ReactElement {
  const rootRef = React.useRef<HTMLFieldSetElement>(null);
  const helpId = React.useId();
  const [isMoving, setIsMoving] = React.useState(serviceType === "moving");
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = React.useState(() =>
    initialCrewMembers.map((member) => member.memberId),
  );
  const [hours, setHours] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialCrewMembers.map((member) => [
        member.memberId,
        member.workedMinutes
          ? String(Number((member.workedMinutes / 60).toFixed(6)))
          : "",
      ]),
    ),
  );
  const [rates, setRates] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialCrewMembers.map((member) => [
        member.memberId,
        member.hourlyRateCents ? (member.hourlyRateCents / 100).toFixed(2) : "",
      ]),
    ),
  );

  // A completion form may include quote conversion or an enabled scope editor.
  // Disabled booking controls cannot change how the crew is paid.
  React.useEffect(() => {
    const form = rootRef.current?.form;
    if (!form) return;
    const sync = () => {
      const nextService = new FormData(form).get("serviceType");
      setIsMoving(
        (typeof nextService === "string" ? nextService : serviceType) ===
          "moving",
      );
    };
    const onChange = () => {
      setValidationError(null);
      queueMicrotask(sync);
    };
    const onSubmit = (event: SubmitEvent) => {
      const submitter = event.submitter;
      if (
        submitter instanceof HTMLButtonElement &&
        submitter.name === "completionMode" &&
        submitter.value === "convert"
      )
        return;
      const result = parseCrewPayoutFormData(new FormData(form));
      if (!result.ok) {
        event.preventDefault();
        setValidationError(result.error);
      }
    };
    sync();
    form.addEventListener("change", onChange);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("change", onChange);
      form.removeEventListener("submit", onSubmit);
    };
  }, [serviceType]);

  const dark = theme === "dark";
  const selectedSet = new Set(selectedIds);
  const availableIds = new Set(teamMembers.map((member) => member.id));
  const visibleMembers = [
    ...teamMembers,
    ...initialCrewMembers
      .filter((member) => !availableIds.has(member.memberId))
      .map((member) => ({
        id: member.memberId,
        name: "Unavailable crew member — remove to continue",
      })),
  ];
  const selectedMembers = visibleMembers.filter((member) =>
    selectedSet.has(member.id),
  );
  const memberPayout = (memberId: string) => {
    const rate = parseHourlyRateCents(rates[memberId]);
    const minutes = parseWorkedMinutes(hours[memberId]);
    return rate !== null && minutes !== null
      ? hourlyPayoutCents(rate, minutes)
      : null;
  };
  const amounts = selectedMembers.map((member) => memberPayout(member.id));
  const total =
    amounts.length && amounts.every((amount) => amount !== null)
      ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)
      : null;
  const inputClass = dark
    ? "min-h-11 w-full min-w-0 rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
    : "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100";

  return (
    <fieldset
      ref={rootRef}
      className="min-w-0 space-y-3"
      aria-describedby={helpId}
    >
      <legend
        className={`text-sm font-semibold ${dark ? "text-slate-100" : "text-slate-900"}`}
      >
        Who worked{isMoving ? " · Hourly pay" : ""}
      </legend>
      <input
        type="hidden"
        name="crewCompensationMode"
        value={isMoving ? "hourly" : "percentage"}
      />
      <p
        id={helpId}
        className={`text-xs leading-5 ${dark ? "text-slate-300" : "text-slate-600"}`}
      >
        {isMoving
          ? "Select the crew, then enter each person's rate and hours. 2.5 hours = 2 hours 30 minutes."
          : "Select everyone who worked this job."}
      </p>
      {validationError ? (
        <p
          role="alert"
          className={`text-sm ${dark ? "text-rose-200" : "text-rose-700"}`}
        >
          {validationError}
        </p>
      ) : null}
      <div
        className={
          stacked
            ? "grid grid-cols-1 gap-2"
            : "grid grid-cols-1 gap-2 sm:grid-cols-2"
        }
      >
        {visibleMembers.map((member) => {
          const checked = selectedSet.has(member.id);
          const payout = checked && isMoving ? memberPayout(member.id) : null;
          return (
            <div
              key={member.id}
              className={`min-w-0 rounded-xl border ${
                dark
                  ? checked
                    ? "border-emerald-300/40 bg-emerald-300/5"
                    : "border-white/10 bg-slate-900"
                  : checked
                    ? "border-primary-300 bg-primary-50"
                    : "border-slate-200 bg-white"
              }`}
            >
              <label
                className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 py-3 text-sm ${dark ? "text-slate-100" : "text-slate-900"}`}
              >
                <input
                  type="checkbox"
                  name="crewMemberId"
                  value={member.id}
                  checked={checked}
                  onChange={() =>
                    setSelectedIds((current) =>
                      current.includes(member.id)
                        ? current.filter((id) => id !== member.id)
                        : [...current, member.id],
                    )
                  }
                  className={`h-5 w-5 shrink-0 rounded ${dark ? "border-slate-500 accent-emerald-300" : "border-slate-300 accent-primary-600"}`}
                />
                <span className="min-w-0 flex-1 font-medium">
                  {member.name}
                </span>
                {payout !== null ? (
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(payout)}
                  </span>
                ) : null}
              </label>
              {checked && isMoving ? (
                <div className="grid grid-cols-2 gap-2 px-3 pb-3">
                  <label
                    className={`min-w-0 space-y-1 text-xs font-medium ${dark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    <span className="block">Hourly rate ($)</span>
                    <input
                      name={`crewHourlyRate:${member.id}`}
                      aria-label={`${member.name} hourly rate`}
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      max="21474836.47"
                      step="0.01"
                      required={requireHourlyInputs}
                      value={rates[member.id] ?? ""}
                      onChange={(event) =>
                        setRates((current) => ({
                          ...current,
                          [member.id]: event.target.value,
                        }))
                      }
                      placeholder="25.00"
                      className={inputClass}
                    />
                  </label>
                  <label
                    className={`min-w-0 space-y-1 text-xs font-medium ${dark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    <span className="block">Hours worked</span>
                    <input
                      name={`crewHours:${member.id}`}
                      aria-label={`${member.name} hours worked`}
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      max="8760"
                      step="any"
                      required={requireHourlyInputs}
                      value={hours[member.id] ?? ""}
                      onChange={(event) =>
                        setHours((current) => ({
                          ...current,
                          [member.id]: event.target.value,
                        }))
                      }
                      placeholder="2.5"
                      title="Decimal hours, rounded to the nearest minute"
                      className={inputClass}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {!visibleMembers.length ? (
        <p
          role="status"
          className={dark ? "text-xs text-amber-100" : "text-xs text-amber-800"}
        >
          No active crew members loaded. Refresh before completing the job.
        </p>
      ) : isMoving ? (
        <div
          aria-live="polite"
          className={`flex min-h-11 items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm ${dark ? "bg-emerald-300/10 text-emerald-100" : "bg-emerald-50 text-emerald-900"}`}
        >
          <span>
            {selectedMembers.length
              ? "Crew labor total"
              : "Select at least one crew member"}
          </span>
          {selectedMembers.length ? (
            <span className="font-semibold tabular-nums">
              {total === null ? "Enter rate + hours" : formatMoney(total)}
            </span>
          ) : null}
        </div>
      ) : selectedMembers.length ? (
        <p
          className={`text-xs leading-5 ${dark ? "text-slate-400" : "text-slate-600"}`}
        >
          {showSplitPercentages
            ? "Payroll applies the current crew split when saved."
            : "Crew pay follows the current Payroll split."}
        </p>
      ) : null}
    </fieldset>
  );
}
