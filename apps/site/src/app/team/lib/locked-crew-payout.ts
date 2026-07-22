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

const TEAM_MEMBER_IDS = {
  austin: "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
  devon: "b45988bb-7417-48c5-af6d-fcdf71088282",
  jeffrey: "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
} as const;

const ADJUSTED_CREW_RULE_KEY = [
  TEAM_MEMBER_IDS.austin,
  TEAM_MEMBER_IDS.devon,
  TEAM_MEMBER_IDS.jeffrey,
]
  .sort()
  .join("|");

const ADJUSTED_CREW_SPLITS = new Map<string, number>([
  [TEAM_MEMBER_IDS.jeffrey, 300],
  [TEAM_MEMBER_IDS.austin, 1000],
  [TEAM_MEMBER_IDS.devon, 700],
]);

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

  if (normalizedMemberIds.join("|") === ADJUSTED_CREW_RULE_KEY) {
    return {
      ok: true,
      splits: normalizedMemberIds.map((memberId) => ({
        memberId,
        splitBps: ADJUSTED_CREW_SPLITS.get(memberId) ?? 0,
      })),
      ruleKey: "austin-devon-jeffrey-adjusted",
      isFallback: false,
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
