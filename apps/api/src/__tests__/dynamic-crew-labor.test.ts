import {
  resolveCrewLaborMemberRateBps,
  resolveCrewLaborPoolRateBps,
} from "@myst-os/pricing";
import {
  allocateCrewCompensationCents,
  resolveConfiguredCrewPayout,
  resolveSavedCrewPoolRateBps,
} from "@/lib/commissions";
import { resolveDynamicCrewPayout } from "@/lib/locked-crew-payout";

describe("dynamic percentage crew labor", () => {
  const staff = ["jeffrey", "jed", "devon", "austin"];

  it.each([
    [1, 2000, 2000],
    [2, 2000, 1000],
    [3, 3000, 1000],
    [4, 3000, 750],
    [5, 3000, 600],
  ])(
    "uses the right pool and equal shares for %i people",
    (count, pool, share) => {
      expect(resolveCrewLaborPoolRateBps(count)).toBe(pool);
      expect(resolveCrewLaborMemberRateBps(count)).toBe(share);
    },
  );

  it("does not count duplicate or blank identities as extra workers", () => {
    expect(
      resolveDynamicCrewPayout(["jed", " jed ", "", "jeffrey"]).splits,
    ).toEqual([
      { memberId: "jed", splitBps: 1, poolRateBps: 2000 },
      { memberId: "jeffrey", splitBps: 1, poolRateBps: 2000 },
    ]);
    expect(resolveCrewLaborMemberRateBps(0)).toBe(0);
    for (const count of [-1, 1.5, Infinity, NaN]) {
      expect(() => resolveCrewLaborPoolRateBps(count)).toThrow(
        "invalid_crew_count",
      );
    }
  });

  it("new completion resolution never reads retired overrides or member guarantees", async () => {
    const select = jest.fn(() => {
      throw new Error("retired configuration read");
    });
    const resolution = await resolveConfiguredCrewPayout(
      { select } as never,
      staff,
    );
    expect(resolution).toMatchObject({ ok: true, ruleKey: "crew-size-equal" });
    if (!resolution.ok) throw new Error("missing_resolution");
    expect(resolution.splits).toHaveLength(4);
    expect(
      resolution.splits.every(
        (entry) =>
          entry.splitBps === 1 &&
          entry.poolRateBps === 3000 &&
          entry.fixedJobRateBps === undefined,
      ),
    ).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it("distributes every cent deterministically with at most a one-cent difference", () => {
    for (const count of [1, 2, 3, 4]) {
      const crew = resolveDynamicCrewPayout(staff.slice(0, count)).splits;
      for (const base of [0, 1, 2, 5, 1001, 100005, 2147483647]) {
        const pool = Math.round(
          (base * resolveSavedCrewPoolRateBps(crew)) / 10000,
        );
        const allocations = allocateCrewCompensationCents(base, pool, crew);
        expect(allocations.reduce((sum, entry) => sum + entry.cents, 0)).toBe(
          pool,
        );
        if (allocations.length) {
          const cents = allocations.map((entry) => entry.cents);
          expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(
            1,
          );
        }
        expect(
          allocateCrewCompensationCents(base, pool, [...crew].reverse()),
        ).toEqual(allocations);
      }
    }
  });

  it("retains legacy weights and guarantees but rejects inconsistent new snapshots", () => {
    const legacy = [
      { memberId: "jed", splitBps: 1, fixedJobRateBps: 1000 },
      { memberId: "jeffrey", splitBps: 1 },
      { memberId: "austin", splitBps: 3 },
    ];
    expect(resolveSavedCrewPoolRateBps(legacy)).toBe(2000);
    expect(
      allocateCrewCompensationCents(100000, 20000, legacy).map((entry) => [
        entry.memberId,
        entry.cents,
      ]),
    ).toEqual([
      ["austin", 7500],
      ["jed", 10000],
      ["jeffrey", 2500],
    ]);
    const valid = resolveDynamicCrewPayout(staff).splits;
    for (const invalid of [
      valid.map((entry, index) =>
        index === 0 ? { ...entry, poolRateBps: undefined } : entry,
      ),
      valid.map((entry) => ({ ...entry, poolRateBps: 2000 })),
      valid.map((entry, index) =>
        index === 0 ? { ...entry, fixedJobRateBps: 1000 } : entry,
      ),
      valid.map((entry, index) =>
        index === 0 ? { ...entry, splitBps: 2 } : entry,
      ),
    ]) {
      expect(() => resolveSavedCrewPoolRateBps(invalid)).toThrow();
    }
  });
});
