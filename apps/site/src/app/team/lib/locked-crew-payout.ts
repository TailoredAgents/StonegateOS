export type LockedCrewPayoutSplit = {
  memberId: string;
  splitBps: number;
};

export type LockedCrewPayoutResolution =
  | {
      ok: true;
      splits: LockedCrewPayoutSplit[];
      ruleKey: string;
      isFallback: boolean;
    }
  | {
      ok: false;
      normalizedMemberIds: string[];
      reason: "missing_rule" | "invalid_rule";
    };

function normalizeMemberIds(memberIds: string[]): string[] {
  return Array.from(
    new Set(
      memberIds
        .map((memberId) => memberId.trim())
        .filter((memberId) => memberId.length > 0),
    ),
  ).sort();
}

function buildEqualSplits(memberIds: string[]): LockedCrewPayoutSplit[] {
  return memberIds.map((memberId) => ({
    memberId,
    splitBps: 1,
  }));
}

export function resolveLockedCrewPayout(
  memberIds: string[],
): LockedCrewPayoutResolution {
  const normalizedMemberIds = normalizeMemberIds(memberIds);

  if (normalizedMemberIds.length === 0) {
    return {
      ok: true,
      splits: [],
      ruleKey: "none",
      isFallback: false,
    };
  }

  if (normalizedMemberIds.length === 1) {
    return {
      ok: true,
      splits: [{ memberId: normalizedMemberIds[0]!, splitBps: 10000 }],
      ruleKey: "solo",
      isFallback: true,
    };
  }

  return {
    ok: true,
    splits: buildEqualSplits(normalizedMemberIds),
    ruleKey: "equal",
    isFallback: true,
  };
}

export function formatLockedCrewSplitPercent(
  splitBps: number,
  totalSplitBps = 10000,
): string {
  const percent =
    totalSplitBps > 0 ? (splitBps / totalSplitBps) * 100 : splitBps / 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
}
