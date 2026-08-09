"use client";

import React from "react";

type TeamMember = {
  id: string;
  name: string;
};

type Props = {
  teamMembers: TeamMember[];
  showSplitPercentages?: boolean;
  stacked?: boolean;
};

function toggleSelection(current: string[], memberId: string): string[] {
  const next = new Set(current);
  if (next.has(memberId)) {
    next.delete(memberId);
  } else {
    next.add(memberId);
  }
  return Array.from(next);
}

export function CrewPayoutSelector({
  teamMembers,
  showSplitPercentages = true,
  stacked = false,
}: Props): React.ReactElement {
  const [selectedMemberIds, setSelectedMemberIds] = React.useState<string[]>(
    [],
  );
  const selectedSet = new Set(selectedMemberIds);
  const selectedMembers = teamMembers.filter((member) =>
    selectedSet.has(member.id),
  );

  return (
    <div className="min-w-0 space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Crew payout
      </div>

      <div
        className={
          stacked
            ? "grid grid-cols-1 gap-2"
            : "grid grid-cols-1 gap-2 sm:grid-cols-2"
        }
      >
        {teamMembers.map((member) => {
          const checked = selectedSet.has(member.id);
          return (
            <label
              key={member.id}
              className={`flex items-center gap-3 rounded-2xl border px-3 py-2 text-sm ${
                checked
                  ? "border-primary-300 bg-primary-50 text-primary-900"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
            >
              <input
                type="checkbox"
                name="crewMemberId"
                value={member.id}
                checked={checked}
                onChange={() =>
                  setSelectedMemberIds((current) =>
                    toggleSelection(current, member.id),
                  )
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="flex-1 font-medium">{member.name}</span>
            </label>
          );
        })}
      </div>

      {selectedMembers.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          Select who worked this job. Mark complete is blocked until at least
          one crew member is selected.
        </div>
      ) : (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
            Crew selected
          </div>
          <div
            className={
              stacked
                ? "mt-2 grid grid-cols-1 gap-2"
                : "mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
            }
          >
            {selectedMembers.map((member) => (
              <div
                key={member.id}
                className="rounded-2xl border border-emerald-200 bg-white px-3 py-2"
              >
                <div className="font-medium">{member.name}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-emerald-700">
            {showSplitPercentages
              ? "The server applies the active Payroll split rule when completion is saved. Review the resulting shares before locking the payout."
              : "Split percentages stay in Payroll and are applied by the server when completion is saved."}
          </div>
        </div>
      )}
    </div>
  );
}
