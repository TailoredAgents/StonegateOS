import {
  DEMO_CREW_POOL_RATE_BPS,
  allocateCrewPoolCents,
  isDemoServicesRequested,
} from "@/lib/commissions";
import { resolveLockedCrewPayout } from "@/lib/locked-crew-payout";

describe("commission rules", () => {
  it("treats booked demo services as demo crew jobs", () => {
    expect(
      isDemoServicesRequested(["junk_removal", "demo-hauloff"]),
    ).toBe(true);
    expect(isDemoServicesRequested(["demo_kitchen"])).toBe(true);
    expect(isDemoServicesRequested(["demolition"])).toBe(false);
    expect(isDemoServicesRequested(["junk_removal"])).toBe(false);
  });

  it("pays Austin and Jeffrey at an exact one-third/two-thirds split", () => {
    const resolved = resolveLockedCrewPayout([
      "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
      "d52dafcd-c571-40ac-ac20-527e4031bc05",
    ]);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("Expected Austin + Jeffrey locked payout rule");
    }

    const poolCents = Math.round(240000 * (DEMO_CREW_POOL_RATE_BPS / 10000));
    const allocations = allocateCrewPoolCents(poolCents, resolved.splits);
    const amountByMemberId = new Map(
      allocations.map((entry) => [entry.memberId, entry.cents]),
    );

    expect(amountByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704")).toBe(
      24000,
    );
    expect(amountByMemberId.get("d52dafcd-c571-40ac-ac20-527e4031bc05")).toBe(
      48000,
    );
  });
});
