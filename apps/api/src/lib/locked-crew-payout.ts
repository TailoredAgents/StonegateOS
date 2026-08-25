export type LockedCrewPayoutSplit = {
  memberId: string;
  splitBps: number;
  /** Guaranteed commission rate against the completed job total. */
  fixedJobRateBps?: number;
};

export type ConfiguredCrewPayoutRule = {
  ruleKey: string;
  splits: LockedCrewPayoutSplit[];
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

function normalizeConfiguredRule(
  rule: ConfiguredCrewPayoutRule,
): ConfiguredCrewPayoutRule | null {
  const ruleKey = rule.ruleKey.normalize("NFKC").trim();
  if (!ruleKey || ruleKey.length > 120 || rule.splits.length < 2) return null;

  const memberIds = new Set<string>();
  const splits: LockedCrewPayoutSplit[] = [];
  for (const split of rule.splits) {
    const memberId = split.memberId.trim();
    if (
      !memberId ||
      memberIds.has(memberId) ||
      !Number.isInteger(split.splitBps) ||
      split.splitBps <= 0 ||
      split.splitBps > 1_000_000
    ) {
      return null;
    }
    memberIds.add(memberId);
    splits.push({ memberId, splitBps: split.splitBps });
  }
  splits.sort((left, right) => left.memberId.localeCompare(right.memberId));
  return { ruleKey, splits };
}

export function resolveLockedCrewPayout(
  memberIds: string[],
  configuredRules: readonly ConfiguredCrewPayoutRule[] = [],
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

  const targetKey = normalizedMemberIds.join("|");
  const matchingRules: ConfiguredCrewPayoutRule[] = [];
  for (const configuredRule of configuredRules) {
    const rule = normalizeConfiguredRule(configuredRule);
    if (!rule) {
      const rawMemberIds = normalizeMemberIds(
        configuredRule.splits.map((split) => split.memberId),
      );
      if (rawMemberIds.join("|") === targetKey) {
        return {
          ok: false,
          normalizedMemberIds,
          reason: "invalid_rule",
        };
      }
      continue;
    }
    if (rule.splits.map((split) => split.memberId).join("|") === targetKey) {
      matchingRules.push(rule);
    }
  }

  if (matchingRules.length > 1) {
    return {
      ok: false,
      normalizedMemberIds,
      reason: "invalid_rule",
    };
  }
  const matchingRule = matchingRules[0];
  if (matchingRule) {
    return {
      ok: true,
      splits: matchingRule.splits,
      ruleKey: matchingRule.ruleKey,
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
