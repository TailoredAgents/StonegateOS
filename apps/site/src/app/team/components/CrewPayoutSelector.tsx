"use client";

import React from "react";
import { useMobileCompletionDraft } from "../../mobile/mobile-completion-draft-context";
import { CrewWorkedTimeFields } from "./CrewWorkedTimeFields";
import { formatCrewWorkedTime } from "../lib/crew-worked-time";
import {
  resolveCrewLaborMemberRateBps,
  resolveCrewLaborPoolRateBps,
} from "@myst-os/pricing";
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
  compact?: boolean;
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
  compact = false,
}: Props): React.ReactElement {
  const rootRef = React.useRef<HTMLFieldSetElement>(null);
  const helpId = React.useId();
  const [isMoving, setIsMoving] = React.useState(serviceType === "moving");
  const [editingCrew, setEditingCrew] = React.useState(false);
  const completionDraft = useMobileCompletionDraft();
  const restoredDraftRevisionRef = React.useRef<number | null>(null);
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

  React.useEffect(() => {
    const draft = completionDraft?.draft;
    if (
      !compact ||
      !draft ||
      restoredDraftRevisionRef.current === completionDraft?.revision
    )
      return;
    restoredDraftRevisionRef.current = completionDraft?.revision ?? null;
    if (draft.crewMemberIds) setSelectedIds(draft.crewMemberIds);
    if (draft.crewHours) setHours(draft.crewHours);
    if (draft.crewRates) setRates(draft.crewRates);
  }, [compact, completionDraft?.draft, completionDraft?.revision]);

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
        setEditingCrew(true);
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
    ...Array.from(
      new Set([
        ...initialCrewMembers.map((member) => member.memberId),
        ...selectedIds,
      ]),
    )
      .filter((memberId) => !availableIds.has(memberId))
      .map((memberId) => ({
        id: memberId,
        name: "Unavailable crew member — remove to continue",
      })),
  ];
  const selectedMembers = visibleMembers.filter((member) =>
    selectedSet.has(member.id),
  );
  const compactValues = new FormData();
  compactValues.set("crewCompensationMode", isMoving ? "hourly" : "percentage");
  for (const memberId of selectedIds) {
    compactValues.append("crewMemberId", memberId);
    compactValues.set(`crewHourlyRate:${memberId}`, rates[memberId] ?? "");
    compactValues.set(`crewHours:${memberId}`, hours[memberId] ?? "");
  }
  const canCollapseCrew =
    parseCrewPayoutFormData(compactValues).ok &&
    selectedIds.every((memberId) => availableIds.has(memberId));
  const showCrewEditor = !compact || editingCrew || !canCollapseCrew;
  const orderedMembers = compact
    ? [...visibleMembers].sort(
        (a, b) => Number(selectedSet.has(b.id)) - Number(selectedSet.has(a.id)),
      )
    : visibleMembers;
  const crewCount = selectedMembers.length;
  const poolPercent = resolveCrewLaborPoolRateBps(crewCount) / 100;
  const memberPercent = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(resolveCrewLaborMemberRateBps(crewCount) / 100);
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
  const percentagePayDetails = (
    <p
      aria-live="polite"
      className={`text-xs leading-5 ${dark ? "text-slate-400" : "text-slate-600"}`}
    >
      {showSplitPercentages
        ? `${poolPercent}% labor pool · ${memberPercent}% of the job total per person. Split equally between ${crewCount} ${crewCount === 1 ? "person" : "people"}. Payroll and job expenses update when saved.`
        : `The labor pool is split equally between ${crewCount} ${crewCount === 1 ? "person" : "people"}. Payroll and job expenses update when saved.`}
    </p>
  );

  return (
    <fieldset
      data-mobile-crew={compact || undefined}
      ref={rootRef}
      className="min-w-0 space-y-3"
      aria-describedby={showCrewEditor ? helpId : undefined}
      onChangeCapture={() => {
        // Becoming valid should not close a crew selection still being edited.
        if (compact) setEditingCrew(true);
      }}
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
      {showCrewEditor ? (
        <p
          id={helpId}
          className={`text-xs leading-5 ${dark ? "text-slate-300" : "text-slate-600"}`}
        >
          {isMoving && compact
            ? "Confirm who worked, their rates, and their hours and minutes."
            : isMoving
              ? "Select the crew, then enter each person's rate and hours. 2.5 hours = 2 hours 30 minutes."
              : "Select everyone who worked this job."}
        </p>
      ) : null}
      {validationError ? (
        <p
          role="alert"
          className={`text-sm ${dark ? "text-rose-200" : "text-rose-700"}`}
        >
          {validationError}
        </p>
      ) : null}
      {!showCrewEditor ? (
        <div
          className={`space-y-2 rounded-xl border p-3 ${dark ? "border-white/10 bg-slate-950" : "border-slate-200 bg-white"}`}
        >
          {selectedMembers.map((member) => (
            <div
              key={member.id}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <input type="hidden" name="crewMemberId" value={member.id} />
              <span className="min-w-0 font-medium">{member.name}</span>
              {isMoving ? (
                <>
                  <input
                    type="hidden"
                    name={`crewHourlyRate:${member.id}`}
                    value={rates[member.id] ?? ""}
                  />
                  <input
                    type="hidden"
                    name={`crewHours:${member.id}`}
                    value={hours[member.id] ?? ""}
                  />
                  <span
                    className={`text-right ${dark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    {formatCrewWorkedTime(hours[member.id] ?? "")} ·{" "}
                    {formatMoney(parseHourlyRateCents(rates[member.id]) ?? 0)}
                    /hr
                  </span>
                </>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditingCrew(true)}
            className={`min-h-11 w-full rounded-md px-3 text-sm font-semibold ${dark ? "text-cyan-100" : "text-primary-600"}`}
          >
            Change crew
          </button>
        </div>
      ) : (
        <div
          className={
            stacked
              ? "grid grid-cols-1 gap-2"
              : "grid grid-cols-1 gap-2 sm:grid-cols-2"
          }
        >
          {orderedMembers.map((member) => {
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
                  ) : checked && !isMoving && showSplitPercentages ? (
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {memberPercent}%
                    </span>
                  ) : null}
                </label>
                {checked && isMoving ? (
                  <div
                    className={`grid gap-2 px-3 pb-3 ${compact ? "grid-cols-1" : "grid-cols-2"}`}
                  >
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
                    {compact ? (
                      <CrewWorkedTimeFields
                        memberId={member.id}
                        memberName={member.name}
                        value={hours[member.id] ?? ""}
                        onChange={(value) =>
                          setHours((current) => ({
                            ...current,
                            [member.id]: value,
                          }))
                        }
                        inputClass={inputClass}
                      />
                    ) : (
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
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {compact && editingCrew && canCollapseCrew ? (
        <button
          type="button"
          onClick={() => setEditingCrew(false)}
          className={`min-h-11 w-full rounded-md px-3 text-sm font-semibold ${dark ? "text-cyan-100" : "text-primary-600"}`}
        >
          Done changing crew
        </button>
      ) : null}
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
      ) : crewCount ? (
        compact ? (
          <details className="rounded-lg border border-white/10 px-3">
            <summary
              className={`flex min-h-11 cursor-pointer items-center text-sm font-semibold ${dark ? "text-slate-300" : "text-slate-600"}`}
            >
              Pay details
            </summary>
            <div className="pb-3">{percentagePayDetails}</div>
          </details>
        ) : (
          percentagePayDetails
        )
      ) : (
        <p
          aria-live="polite"
          className={`text-xs leading-5 ${dark ? "text-slate-400" : "text-slate-600"}`}
        >
          Select at least one crew member. Labor is 20% for 1–2 people and 30%
          for 3 or more, split equally.
        </p>
      )}
    </fieldset>
  );
}
