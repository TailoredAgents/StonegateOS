import {
  allocateCrewPoolCents,
  isDemoBookingDetails,
  isDemoCommissionJob,
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

  it("treats demolition booking details as demo crew jobs", () => {
    expect(
      isDemoBookingDetails({
        serviceType: "demolition",
        demolition: { demoType: "fence", scopeSize: "12x16", haulAway: true },
      }),
    ).toBe(true);
    expect(
      isDemoCommissionJob({
        servicesRequested: [],
        bookingDetails: {
          serviceType: "demolition",
          demolition: {
            demoType: "fence",
            scopeSize: "12x16",
            haulAway: true,
          },
        },
      }),
    ).toBe(true);
    expect(
      isDemoBookingDetails({
        serviceType: "junk_removal",
      }),
    ).toBe(false);
  });

  it("pays Austin and Jeffrey an even split of the 20% labor pool", () => {
    const resolved = resolveLockedCrewPayout([
      "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
      "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
    ]);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("Expected Austin + Jeffrey locked payout rule");
    }

    const poolCents = Math.round(240000 * (2000 / 10000));
    const allocations = allocateCrewPoolCents(poolCents, resolved.splits);
    const amountByMemberId = new Map(
      allocations.map((entry) => [entry.memberId, entry.cents]),
    );
    expect(amountByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704")).toBe(
      24000,
    );
    expect(amountByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3")).toBe(
      24000,
    );
  });

  it("adjusts Austin, Jeffrey, and Devon labor so Austin and Jeffrey total 15%", () => {
    const resolved = resolveLockedCrewPayout([
      "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
      "b45988bb-7417-48c5-af6d-fcdf71088282",
      "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
    ]);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("Expected Austin + Devon + Jeffrey payout rule");
    }

    expect(resolved.ruleKey).toBe("austin-devon-jeffrey-adjusted");
    const allocations = allocateCrewPoolCents(20000, resolved.splits);
    const amountByMemberId = new Map(
      allocations.map((entry) => [entry.memberId, entry.cents]),
    );
    const managementByMemberId = new Map([
      ["239ca36d-e618-4c5c-a283-b6e5d4ccb704", 5000],
      ["5ac5217e-3905-4ea3-bdeb-65456982f5e3", 12000],
    ]);

    expect(amountByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704")).toBe(
      10000,
    );
    expect(amountByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3")).toBe(
      3000,
    );
    expect(amountByMemberId.get("b45988bb-7417-48c5-af6d-fcdf71088282")).toBe(
      7000,
    );
    expect(
      (amountByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704") ?? 0) +
        (managementByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704") ??
          0),
    ).toBe(15000);
    expect(
      (amountByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3") ?? 0) +
        (managementByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3") ??
          0),
    ).toBe(15000);
    expect(
      amountByMemberId.get("b45988bb-7417-48c5-af6d-fcdf71088282"),
    ).toBe(7000);
  });

  it("falls back to an even split for other crew combinations", () => {
    const resolved = resolveLockedCrewPayout([
      "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
      "b45988bb-7417-48c5-af6d-fcdf71088282",
    ]);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("Expected fallback crew payout rule");
    }
    expect(resolved.ruleKey).toBe("equal");
    expect(resolved.splits).toEqual([
      { memberId: "5ac5217e-3905-4ea3-bdeb-65456982f5e3", splitBps: 1 },
      { memberId: "b45988bb-7417-48c5-af6d-fcdf71088282", splitBps: 1 },
    ]);
  });
});
