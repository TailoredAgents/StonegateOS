import {
  DEMO_CREW_POOL_RATE_BPS,
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

  it("pays Austin and Jeffrey at an even 50/50 split", () => {
    const resolved = resolveLockedCrewPayout([
      "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
      "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
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
      36000,
    );
    expect(amountByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3")).toBe(
      36000,
    );
  });

  it("pays Austin, Jeffrey, and Devon at a 40/40/20 split", () => {
    const resolved = resolveLockedCrewPayout([
      "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
      "b45988bb-7417-48c5-af6d-fcdf71088282",
      "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
    ]);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("Expected Austin + Devon + Jeffrey locked payout rule");
    }

    const allocations = allocateCrewPoolCents(10000, resolved.splits);
    const amountByMemberId = new Map(
      allocations.map((entry) => [entry.memberId, entry.cents]),
    );

    expect(amountByMemberId.get("239ca36d-e618-4c5c-a283-b6e5d4ccb704")).toBe(
      4000,
    );
    expect(amountByMemberId.get("5ac5217e-3905-4ea3-bdeb-65456982f5e3")).toBe(
      4000,
    );
    expect(amountByMemberId.get("b45988bb-7417-48c5-af6d-fcdf71088282")).toBe(
      2000,
    );
  });
});
