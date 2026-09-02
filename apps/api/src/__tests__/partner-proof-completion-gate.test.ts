import fs from "node:fs";
import path from "node:path";
import {
  evaluatePartnerProofCompletion,
  recordPartnerProofCompletionOverride,
} from "@/lib/partner-proof-completion";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function evaluationTransaction(input: {
  booking?: {
    id: string;
    partnerAccountId: string | null;
    proofRequirementsSnapshot: Record<string, unknown> | null;
  };
  requirements?: Array<{
    partnerBookingId: string | null;
    category: string;
    required: boolean;
    minimumCount: number;
  }>;
  evidence?: Array<{ category: string }>;
}): TeamMutationTransaction {
  let call = 0;
  return {
    select: () => {
      call += 1;
      return {
        from: () => {
          if (call === 1) {
            return {
              where: () => ({
                for: () => ({
                  limit: () => Promise.resolve(input.booking ? [input.booking] : []),
                }),
              }),
            };
          }
          if (call === 2) {
            return {
              where: () => ({
                orderBy: () => Promise.resolve(input.requirements ?? []),
              }),
            };
          }
          return {
            innerJoin: () => ({
              where: () => Promise.resolve(input.evidence ?? []),
            }),
          };
        },
      };
    },
  } as unknown as TeamMutationTransaction;
}

describe("partner proof completion gate", () => {
  it("does not apply partner proof policy to ordinary appointments", async () => {
    await expect(
      evaluatePartnerProofCompletion(
        evaluationTransaction({}),
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ kind: "not_partner_job" });
  });

  it("falls back to the immutable booking snapshot and reports exact deficits", async () => {
    const decision = await evaluatePartnerProofCompletion(
      evaluationTransaction({
        booking: {
          id: "22222222-2222-4222-8222-222222222222",
          partnerAccountId: "33333333-3333-4333-8333-333333333333",
          proofRequirementsSnapshot: { before: 2, after: 1 },
        },
        evidence: [{ category: "before" }],
      }),
      "11111111-1111-4111-8111-111111111111",
    );

    expect(decision).toEqual({
      kind: "missing",
      partnerAccountId: "33333333-3333-4333-8333-333333333333",
      partnerBookingId: "22222222-2222-4222-8222-222222222222",
      missing: [
        { category: "after", minimumCount: 1, availableCount: 0 },
        { category: "before", minimumCount: 2, availableCount: 1 },
      ],
    });
  });

  it("uses job requirements over account defaults", async () => {
    const bookingId = "22222222-2222-4222-8222-222222222222";
    const decision = await evaluatePartnerProofCompletion(
      evaluationTransaction({
        booking: {
          id: bookingId,
          partnerAccountId: "33333333-3333-4333-8333-333333333333",
          proofRequirementsSnapshot: { before: 1, after: 1 },
        },
        requirements: [
          {
            partnerBookingId: null,
            category: "before",
            required: true,
            minimumCount: 2,
          },
          {
            partnerBookingId: bookingId,
            category: "before",
            required: false,
            minimumCount: 0,
          },
          {
            partnerBookingId: null,
            category: "after",
            required: true,
            minimumCount: 1,
          },
        ],
        evidence: [{ category: "after" }],
      }),
      "11111111-1111-4111-8111-111111111111",
    );

    expect(decision).toEqual({
      kind: "satisfied",
      partnerAccountId: "33333333-3333-4333-8333-333333333333",
      partnerBookingId: bookingId,
    });
  });

  it("records reasoned job exceptions without mutating account defaults", async () => {
    const updated: Array<Record<string, unknown>> = [];
    const inserted: Array<Record<string, unknown>> = [];
    const transaction = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ id: "before-row", category: "before" }]),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updated.push(values);
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return Promise.resolve();
        },
      }),
    };
    const now = new Date("2026-09-01T12:00:00.000Z");
    await recordPartnerProofCompletionOverride(transaction, {
      decision: {
        kind: "missing",
        partnerAccountId: "33333333-3333-4333-8333-333333333333",
        partnerBookingId: "22222222-2222-4222-8222-222222222222",
        missing: [
          { category: "before", minimumCount: 1, availableCount: 0 },
          { category: "after", minimumCount: 1, availableCount: 0 },
        ],
      },
      reason: "Site access prevented safe photo capture.",
      teamMemberId: "44444444-4444-4444-8444-444444444444",
      now,
    });

    expect(updated).toEqual([
      expect.objectContaining({
        required: false,
        minimumCount: 0,
        source: "staff_override",
        overrideReason: "Site access prevented safe photo capture.",
        overriddenByTeamMemberId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
    expect(inserted).toEqual([
      expect.objectContaining({
        partnerBookingId: "22222222-2222-4222-8222-222222222222",
        category: "after",
        source: "staff_override",
        createdAt: now,
      }),
    ]);
  });

  it("binds completion enforcement, authorization, UI, and new-account defaults", () => {
    const statusRoute = source("app/api/appointments/[id]/status/route.ts");
    const onboarding = source("src/lib/partner-verification-onboarding.ts");
    const proofRoute = source(
      "app/api/portal/v2/jobs/[jobId]/proof/requirements/route.ts",
    );
    const calendar = source(
      "../site/src/app/team/components/CalendarAppointmentActions.tsx",
    );
    const myDay = source(
      "../site/src/app/team/components/MyDaySection.tsx",
    );
    const mobile = source("../site/src/app/mobile/page.tsx");

    expect(statusRoute).toContain("evaluatePartnerProofCompletion(");
    expect(statusRoute).toContain("recordPartnerProofCompletionOverride(tx");
    expect(statusRoute).toContain('"partner_proof_required"');
    expect(statusRoute).toContain('"appointment_media.manage"');
    expect(statusRoute).toContain('risk: input.requiresProofOverride\n      ? "destructive"');
    expect(statusRoute).toContain("proofOverrideApplied,");
    expect(onboarding).toContain("insert(partnerEvidenceRequirements)");
    expect(onboarding).toContain('category: "before"');
    expect(onboarding).toContain('category: "after"');
    expect(proofRoute).toContain("overrideReason: null");
    expect(calendar).toContain('name="proofOverrideReason"');
    expect(myDay).toContain('name="proofOverrideReason"');
    expect(mobile).toContain('name="proofOverrideReason"');
  });
});
