import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateDuePartnerRecurringOccurrences,
  normalizeRecurringHorizonBatchLimit,
  recurringHorizonPosition,
} from "@/lib/partner-recurring-horizon-scheduler";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("partner recurring horizon scheduler", () => {
  it("uses account-local calendar days and includes exactly the 30-day edge", () => {
    const now = new Date("2026-08-30T16:00:00.000Z");
    const position = (localDate: string) =>
      recurringHorizonPosition({
        localDate,
        timezone: "America/New_York",
        now,
      });

    expect(position("2026-08-30")).toBe("elapsed");
    expect(position("2026-08-31")).toBe("inside_horizon");
    expect(position("2026-09-29")).toBe("inside_horizon");
    expect(position("2026-09-30")).toBe("outside_horizon");
  });

  it("preserves calendar-day horizon semantics across daylight-saving time", () => {
    const now = new Date("2026-03-07T17:00:00.000Z");

    expect(
      recurringHorizonPosition({
        localDate: "2026-04-06",
        timezone: "America/New_York",
        now,
      }),
    ).toBe("inside_horizon");
    expect(
      recurringHorizonPosition({
        localDate: "2026-04-07",
        timezone: "America/New_York",
        now,
      }),
    ).toBe("outside_horizon");
  });

  it("bounds every maintenance batch", () => {
    expect(normalizeRecurringHorizonBatchLimit(undefined)).toBe(20);
    expect(normalizeRecurringHorizonBatchLimit(Number.NaN)).toBe(20);
    expect(normalizeRecurringHorizonBatchLimit(0)).toBe(1);
    expect(normalizeRecurringHorizonBatchLimit(12.9)).toBe(12);
    expect(normalizeRecurringHorizonBatchLimit(5_000)).toBe(100);
  });

  it("stops before database work when the production kill switch is off", async () => {
    const previous = process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"];
    process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"] = "0";
    try {
      await expect(
        evaluateDuePartnerRecurringOccurrences({
          limit: 100,
          now: new Date("2026-08-30T16:00:00.000Z"),
        }),
      ).resolves.toEqual({
        enabled: false,
        scanned: 0,
        claimed: 0,
        confirmed: 0,
        review: 0,
        failed: 0,
        tentative: 0,
        staffTasksCreated: 0,
        recoveredStale: 0,
        skippedFeatureDisabled: 0,
      });
    } finally {
      if (previous === undefined) {
        delete process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"];
      } else {
        process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"] = previous;
      }
    }
  });

  it("does no maintenance writes while portal V2 writes are disabled", async () => {
    const previousEvaluator =
      process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"];
    const previousWrites = process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"];
    process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"] = "1";
    process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "0";
    try {
      const result = await evaluateDuePartnerRecurringOccurrences({ limit: 1 });
      expect(result).toMatchObject({
        enabled: true,
        scanned: 0,
        claimed: 0,
      });
    } finally {
      if (previousEvaluator === undefined) {
        delete process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"];
      } else {
        process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"] =
          previousEvaluator;
      }
      if (previousWrites === undefined) {
        delete process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"];
      } else {
        process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = previousWrites;
      }
    }
  });

  it("claims with a lease, reuses unified scheduling, and creates no outside-horizon hold", () => {
    const scheduler = source(
      "apps/api/src/lib/partner-recurring-horizon-scheduler.ts",
    );
    const repeatWork = source("apps/api/src/lib/partner-repeat-work.ts");
    const worker = source("scripts/outbox-worker.ts");

    expect(scheduler).toContain("partner_recurring_horizon_claim_v1");
    expect(scheduler).toContain('state: "evaluating"');
    expect(scheduler).toContain("EVALUATION_LEASE_MINUTES");
    expect(scheduler).toContain("arePartnerPortalV2WritesEnabled");
    expect(scheduler).toContain(
      "configuredPartnerPortalInternalAccountIds",
    );
    expect(scheduler).toContain(
      '"PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"',
    );
    expect(scheduler).toContain("evaluateClaimedPartnerRecurringOccurrence");
    expect(repeatWork).toContain("createOrReplacePartnerHold");
    expect(repeatWork).toContain("submitPartnerBookingDraft");
    expect(repeatWork).toContain("reconciledFromIdempotentSubmission: true");
    expect(repeatWork).toContain("partner_recurring_staff_action");
    expect(repeatWork).toContain("reservationCreated: false");
    expect(repeatWork).not.toContain("outboxEvents");
    expect(worker).toContain("runPartnerRecurringHorizonOnce");
    expect(worker).toContain("PARTNER_RECURRING_HORIZON_BATCH_SIZE");
    expect(worker).toContain("PARTNER_RECURRING_HORIZON_INTERVAL_MS");
  });
});
