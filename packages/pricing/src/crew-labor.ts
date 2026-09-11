/** Percentage labor policy for non-moving jobs; amounts are basis points. */
export function resolveCrewLaborPoolRateBps(crewCount: number): number {
  if (!Number.isSafeInteger(crewCount) || crewCount < 0) {
    throw new Error("invalid_crew_count");
  }
  return crewCount === 0 ? 0 : crewCount <= 2 ? 2_000 : 3_000;
}

export function resolveCrewLaborMemberRateBps(crewCount: number): number {
  const poolRateBps = resolveCrewLaborPoolRateBps(crewCount);
  return crewCount === 0 ? 0 : poolRateBps / crewCount;
}
