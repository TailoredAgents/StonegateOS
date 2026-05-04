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

const TEAM_MEMBER_IDS = {
  austin: "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
  devon: "b45988bb-7417-48c5-af6d-fcdf71088282",
  jeffrey: "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
} as const;

type ExactCrewRule = {
  key: string;
  memberIds: readonly string[];
  splitBpsByMemberId: Record<string, number>;
};

const EXACT_CREW_RULES: readonly ExactCrewRule[] = [
  {
    key: "austin+jeffrey",
    memberIds: [TEAM_MEMBER_IDS.austin, TEAM_MEMBER_IDS.jeffrey],
    splitBpsByMemberId: {
      [TEAM_MEMBER_IDS.austin]: 5000,
      [TEAM_MEMBER_IDS.jeffrey]: 5000,
    },
  },
  {
    key: "austin+devon",
    memberIds: [TEAM_MEMBER_IDS.austin, TEAM_MEMBER_IDS.devon],
    splitBpsByMemberId: {
      [TEAM_MEMBER_IDS.austin]: 5000,
      [TEAM_MEMBER_IDS.devon]: 5000,
    },
  },
  {
    key: "austin+devon+jeffrey",
    memberIds: [
      TEAM_MEMBER_IDS.austin,
      TEAM_MEMBER_IDS.devon,
      TEAM_MEMBER_IDS.jeffrey,
    ],
    splitBpsByMemberId: {
      [TEAM_MEMBER_IDS.austin]: 3000,
      [TEAM_MEMBER_IDS.devon]: 4000,
      [TEAM_MEMBER_IDS.jeffrey]: 3000,
    },
  },
] as const;

function normalizeMemberIds(memberIds: string[]): string[] {
  return Array.from(
    new Set(
      memberIds
        .map((memberId) => memberId.trim())
        .filter((memberId) => memberId.length > 0),
    ),
  ).sort();
}

function buildExactRuleLookupKey(memberIds: readonly string[]): string {
  return [...memberIds].sort().join("|");
}

const EXACT_CREW_RULES_BY_KEY = new Map(
  EXACT_CREW_RULES.map((rule) => [
    buildExactRuleLookupKey(rule.memberIds),
    rule,
  ]),
);

function isValidSplitTotal(splits: LockedCrewPayoutSplit[]): boolean {
  if (splits.some((entry) => entry.splitBps <= 0)) return false;
  return splits.reduce((sum, entry) => sum + entry.splitBps, 0) > 0;
}

function buildEqualSplits(memberIds: string[]): LockedCrewPayoutSplit[] {
  const baseSplitBps = Math.floor(10000 / memberIds.length);
  let remainingBps = 10000 - baseSplitBps * memberIds.length;
  return memberIds.map((memberId) => {
    const extraBps = remainingBps > 0 ? 1 : 0;
    remainingBps -= extraBps;
    return {
      memberId,
      splitBps: baseSplitBps + extraBps,
    };
  });
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

  const exactRule = EXACT_CREW_RULES_BY_KEY.get(
    buildExactRuleLookupKey(normalizedMemberIds),
  );
  if (!exactRule) {
    return {
      ok: true,
      splits: buildEqualSplits(normalizedMemberIds),
      ruleKey: "equal",
      isFallback: true,
    };
  }

  const splits = normalizedMemberIds.map((memberId) => ({
    memberId,
    splitBps: exactRule.splitBpsByMemberId[memberId] ?? 0,
  }));

  if (!isValidSplitTotal(splits)) {
    return {
      ok: false,
      normalizedMemberIds,
      reason: "invalid_rule",
    };
  }

  return {
    ok: true,
    splits,
    ruleKey: exactRule.key,
    isFallback: false,
  };
}
