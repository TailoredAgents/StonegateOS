import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_GLOBAL_PARTNER_CANCELLATION_POLICY,
  evaluatePartnerCancellation,
  narrowGlobalPartnerCancellationPolicy,
  resolvePartnerCancellationPolicy,
  resolvePersistedPartnerAccountCancellationPolicy,
  validatePartnerAccountCancellationPolicy,
} from "@/lib/partner-portal-v2-cancellation";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("Partner account cancellation policy", () => {
  it("uses max/AND precedence so an account cannot broaden Stonegate rules", () => {
    expect(
      narrowGlobalPartnerCancellationPolicy({
        global: {
          ...DEFAULT_GLOBAL_PARTNER_CANCELLATION_POLICY,
          minimumNoticeMinutes: 2_880,
          directCancellationEnabled: false,
        },
        account: {
          minimumNoticeMinutes: 1_440,
          directCancellationEnabled: true,
          lateCancellationDisposition: "staff_review",
          automaticFeeMinor: null,
        },
      }),
    ).toEqual({
      minimumNoticeMinutes: 2_880,
      directCancellationEnabled: false,
      lateCancellationDisposition: "staff_review",
      automaticFeeMinor: null,
    });
  });

  it("rejects account values that try to shorten the 24-hour baseline or add a fee", () => {
    expect(() =>
      validatePartnerAccountCancellationPolicy({
        minimumNoticeMinutes: 1_439,
        directCancellationEnabled: true,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: null,
      }),
    ).toThrow(TypeError);
    expect(
      resolvePersistedPartnerAccountCancellationPolicy({
        minimumNoticeMinutes: 1_440,
        directCancellationEnabled: true,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: 5_000,
        revision: 1,
      }),
    ).toBeNull();
  });

  it("makes the exact cutoff a staff-review reschedule/cancellation consequence", () => {
    const policy = resolvePartnerCancellationPolicy({
      timezone: "America/New_York",
      accountPolicy: {
        minimumNoticeMinutes: 1_440,
        directCancellationEnabled: true,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: null,
        revision: 4,
      },
    });
    expect(
      evaluatePartnerCancellation({
        status: "confirmed",
        promisedArrivalStartAt: new Date("2026-09-10T14:00:00.000Z"),
        now: new Date("2026-09-09T14:00:00.000Z"),
        canCancel: true,
        reviewPending: false,
        policy,
      }),
    ).toMatchObject({
      action: "request_cancellation_review",
      reason: { code: "cutoff_elapsed" },
      policyRevision: 4,
      consequence: {
        code: "staff_review_without_automatic_fee",
        automaticFeeMinor: null,
      },
    });
  });

  it("loads policy after the schedule lock in cancellation and reschedule transactions", () => {
    const cancellation = source(
      "app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    );
    const reschedule = source(
      "src/lib/partner-portal-v2-scheduling/service.ts",
    );
    const cancelLock = cancellation.indexOf(
      "await acquireScheduleConflictLock(tx)",
    );
    const cancelPolicy = cancellation.indexOf(
      "partnerAccountCancellationPolicies",
      cancelLock,
    );
    const rescheduleStart = reschedule.indexOf(
      "export async function reschedulePartnerBooking",
    );
    const rescheduleLock = reschedule.indexOf(
      "await acquireScheduleConflictLock(tx)",
      rescheduleStart,
    );
    const reschedulePolicy = reschedule.indexOf(
      ".from(partnerAccountCancellationPolicies)",
      rescheduleLock,
    );
    expect(cancelLock).toBeGreaterThan(0);
    expect(cancelPolicy).toBeGreaterThan(cancelLock);
    expect(reschedulePolicy).toBeGreaterThan(rescheduleLock);
    expect(reschedule).toContain('"schedule_change_policy_review_required"');
    expect(reschedule).toContain("currentSchedulePreserved: true");
  });

  it("exposes a safe Partner read and an authenticated Staff writer", () => {
    const partnerRoute = source(
      "app/api/portal/v2/cancellation-policy/route.ts",
    );
    const staffRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/cancellation-policy/route.ts",
    );
    expect(partnerRoute).toMatch(
      /requirePartnerCapability\(\s*request,\s*"bookings\.create"/u,
    );
    expect(partnerRoute).toContain("createPortalV2StrongEtag");
    expect(staffRoute).toContain(
      'requiredPermissions: ["partners.accounts.manage"]',
    );
    expect(staffRoute).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(staffRoute).toContain("claimTeamMutationIdempotency");
    expect(staffRoute).toContain("mutation.audit.insertSuccess");
    expect(staffRoute).toContain(
      "updatePartnerAccountCancellationPolicyAsStaff",
    );
  });

  it("discloses exact terms before booking, cancellation, and rescheduling", () => {
    const booking = source(
      "../site/src/app/partners/components/PartnerBookingWizard.tsx",
    );
    const actions = source(
      "../site/src/app/partners/components/PartnerJobActions.tsx",
    );
    const reschedule = source(
      "../site/src/app/partners/components/PartnerRescheduleFlow.tsx",
    );
    expect(booking).toContain('id="partner-book-cancellation-terms"');
    expect(booking).toContain(
      'aria-describedby="partner-book-cancellation-terms"',
    );
    expect(actions).toContain('id="partner-cancellation-consequence"');
    expect(actions).toContain("cancellation.consequence.label");
    expect(reschedule).toContain('id="partner-reschedule-policy"');
    expect(reschedule).toContain("existing schedule remains in place");
  });

  it("creates and seeds migration 0148 with fixed review/no-fee constraints", () => {
    const migration = source(
      "src/db/migrations/0148_partner_account_cancellation_policy.sql",
    );
    expect(migration).toContain(
      'CREATE TABLE "partner_account_cancellation_policies"',
    );
    expect(migration).toContain(
      'CHECK ("minimum_notice_minutes" BETWEEN 1440 AND 525600)',
    );
    expect(migration).toContain(
      "CHECK (\"late_cancellation_disposition\" = 'staff_review')",
    );
    expect(migration).toContain('CHECK ("automatic_fee_minor" IS NULL)');
    expect(migration).toContain(
      'CREATE TRIGGER "partner_accounts_seed_cancellation_policy"',
    );
  });
});
