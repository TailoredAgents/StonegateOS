import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRecurringSeriesLifecycleMutation,
  recurringOccurrenceLifecycleTransition,
} from "@/lib/partner-repeat-work";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("partner recurring-series lifecycle", () => {
  it("accepts only bounded pause, resume, and cancel mutations", () => {
    expect(
      parseRecurringSeriesLifecycleMutation({
        action: "pause",
        reason: " Waiting for turnover dates. ",
      }),
    ).toEqual({ action: "pause", reason: "Waiting for turnover dates." });
    expect(() =>
      parseRecurringSeriesLifecycleMutation({
        action: "delete",
        reason: "No longer needed",
      }),
    ).toThrow("Review the recurring schedule change");
    expect(() =>
      parseRecurringSeriesLifecycleMutation({
        action: "cancel",
        reason: "x".repeat(301),
      }),
    ).toThrow("Review the recurring schedule change");
    expect(() =>
      parseRecurringSeriesLifecycleMutation({
        action: "resume",
        reason: "Ready",
        force: true,
      }),
    ).toThrow("Review the recurring schedule change");
  });

  it("changes only future unbooked lifecycle-owned occurrences", () => {
    const base = {
      localDate: "2026-09-10",
      tomorrow: "2026-09-02",
      state: "tentative",
      failureCode: null,
      bookingDraftId: null,
      partnerBookingId: null,
    };
    expect(
      recurringOccurrenceLifecycleTransition({ ...base, action: "pause" }),
    ).toBe("skipped");
    expect(
      recurringOccurrenceLifecycleTransition({
        ...base,
        action: "resume",
        state: "skipped",
        failureCode: "series_paused",
      }),
    ).toBe("tentative");
    expect(
      recurringOccurrenceLifecycleTransition({
        ...base,
        action: "cancel",
        state: "skipped",
        failureCode: "series_paused",
      }),
    ).toBe("canceled");
    expect(
      recurringOccurrenceLifecycleTransition({
        ...base,
        action: "cancel",
        partnerBookingId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBeNull();
    expect(
      recurringOccurrenceLifecycleTransition({
        ...base,
        action: "pause",
        localDate: "2026-09-01",
      }),
    ).toBeNull();
    expect(
      recurringOccurrenceLifecycleTransition({
        ...base,
        action: "resume",
        state: "skipped",
        failureCode: "occurrence_date_elapsed",
      }),
    ).toBeNull();
  });

  it("coordinates claims, schedule writes, CAS, audit, and receipts in one domain transaction", () => {
    const service = source("apps/api/src/lib/partner-repeat-work.ts");
    const coordination = source(
      "apps/api/src/lib/partner-recurring-coordination.ts",
    );
    const scheduler = source(
      "apps/api/src/lib/partner-recurring-horizon-scheduler.ts",
    );
    const lifecycle = service.slice(
      service.indexOf(
        "export async function mutatePartnerRecurringSeriesLifecycle",
      ),
      service.indexOf("export async function createPartnerRecurringSeries"),
    );
    expect(lifecycle).toContain("getDb().transaction");
    expect(
      lifecycle.indexOf("acquirePartnerRecurringHorizonClaimLock"),
    ).toBeLessThan(lifecycle.indexOf("acquireScheduleConflictLock"));
    expect(lifecycle).toContain("partner_recurring_series_lifecycle_v1");
    expect(lifecycle).toContain("teamMutationIdempotency");
    expect(lifecycle).toContain("requestHash");
    expect(lifecycle).toContain("evaluatePortalV2RevisionPrecondition");
    expect(lifecycle).toContain("eq(partnerRecurringSeries.revision");
    expect(lifecycle).toContain('occurrence.state === "evaluating"');
    expect(lifecycle).toContain(
      "isNull(partnerRecurringOccurrences.bookingDraftId)",
    );
    expect(lifecycle).toContain(
      "isNull(partnerRecurringOccurrences.partnerBookingId)",
    );
    expect(lifecycle).not.toContain(
      "evaluateClaimedPartnerRecurringOccurrence",
    );
    expect(scheduler).toContain("acquirePartnerRecurringHorizonClaimLock(tx)");
    expect(coordination).toContain("pg_advisory_xact_lock");
  });

  it("exposes a bounded, revision-safe route and accessible lifecycle controls", () => {
    const route = source(
      "apps/api/app/api/portal/v2/recurring-series/[seriesId]/route.ts",
    );
    const ui = source(
      "apps/site/src/app/partners/components/PartnerRepeatWorkManager.tsx",
    );
    expect(route).toContain('"bookings.read"');
    expect(route).toContain('"bookings.update"');
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(route).toContain("maximumBytes: 4 * 1024");
    expect(route).toContain("rejectDuplicateObjectKeys: true");
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain("requestIfMatch(request)");
    expect(route).toContain("ETag: result.series.etag");
    expect(ui).toContain('"If-Match": item.etag');
    expect(ui).toContain("Reason for schedule change");
    expect(ui).toContain("Existing");
    expect(ui).toContain("jobs and review requests remain unchanged");
    expect(ui).toContain("aria-describedby={helpId}");
    expect(ui).toContain('role="status"');
  });
});
