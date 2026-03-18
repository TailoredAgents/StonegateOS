"use client";

import React from "react";
import {
  formatLockedCrewSplitPercent,
  resolveLockedCrewPayout,
} from "../lib/locked-crew-payout";

type TeamMember = {
  id: string;
  name: string;
};

type Props = {
  teamMembers: TeamMember[];
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

export function CrewPayoutSelector({ teamMembers }: Props): React.ReactElement {
  const [selectedMemberIds, setSelectedMemberIds] = React.useState<string[]>(
    [],
  );
  const selectedSet = new Set(selectedMemberIds);
  const selectedMembers = teamMembers.filter((member) =>
    selectedSet.has(member.id),
  );
  const resolvedCrewPayout = resolveLockedCrewPayout(selectedMemberIds);
  const splitByMemberId = new Map(
    resolvedCrewPayout.ok
      ? resolvedCrewPayout.splits.map((entry) => [
          entry.memberId,
          entry.splitBps,
        ])
      : [],
  );

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Crew payout
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          Select who worked this job. If nobody is selected, no crew payout will
          be created.
        </div>
      ) : resolvedCrewPayout.ok ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
            Locked split
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {selectedMembers.map((member) => (
              <div
                key={member.id}
                className="rounded-2xl border border-emerald-200 bg-white px-3 py-2"
              >
                <div className="font-medium">{member.name}</div>
                <div className="text-xs text-emerald-700">
                  {formatLockedCrewSplitPercent(
                    splitByMemberId.get(member.id) ?? 0,
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-emerald-700">
            Crew payout is locked by this combo and cannot be edited manually.
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-[11px] text-amber-800">
          No locked payout rule exists for this crew combination yet. Mark
          complete will be blocked until that combo has a saved rule.
        </div>
      )}
    </div>
  );
}
