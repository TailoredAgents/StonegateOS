import {
  closeDbForTests,
  expenseAllocations,
  expenseDumpDetails,
  expenseReimbursementClaims,
  expenseVendorCategoryRules,
  expenses,
  getDb,
  payoutRunAdjustments,
  payoutRuns,
  teamMembers,
} from "@/db";
import { and, eq } from "drizzle-orm";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
  reviewExpenseSubmissionInTransaction,
} from "@/lib/expense-submissions";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

describeOrSkip("Expense submission workflow integration", () => {
  const ROLLBACK = new Error("expense_submission_test_rollback");
  const originalReimbursementFlag =
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"];

  beforeAll(() => {
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = "1";
  });

  afterAll(async () => {
    if (originalReimbursementFlag === undefined) {
      delete process.env["EXPENSE_REIMBURSEMENT_ENABLED"];
    } else {
      process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = originalReimbursementFlag;
    }
    await closeDbForTests();
  });

  it("posts owners, queues crew, rejects safely, and reimburses one expense once", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T14:00:00.000Z");
        const [owner, crew] = await tx
          .insert(teamMembers)
          .values([
            { name: "Expense owner", active: true },
            { name: "Expense crew", active: true },
          ])
          .returning({ id: teamMembers.id });
        expect(owner?.id).toBeTruthy();
        expect(crew?.id).toBeTruthy();
        if (!owner || !crew) throw new Error("test_members_missing");

        const [lockedPayout, stalePayout, payout] = await tx
          .insert(payoutRuns)
          .values([
            {
              timezone: "America/New_York",
              periodStart: new Date("2026-08-17T04:00:00.000Z"),
              periodEnd: new Date("2026-08-24T04:00:00.000Z"),
              scheduledPayoutAt: new Date("2026-08-24T16:00:00.000Z"),
              periodCanonical: true,
              status: "locked",
              lockedAt: now,
              createdBy: owner.id,
              createdAt: now,
              updatedAt: now,
            },
            {
              timezone: "America/New_York",
              periodStart: new Date("2026-08-17T04:00:00.000Z"),
              periodEnd: new Date("2026-08-24T04:00:00.000Z"),
              scheduledPayoutAt: new Date("2026-08-24T16:00:00.000Z"),
              periodCanonical: false,
              status: "draft",
              createdBy: owner.id,
              createdAt: now,
              updatedAt: now,
            },
            {
              timezone: "America/New_York",
              periodStart: new Date("2026-08-24T04:00:00.000Z"),
              periodEnd: new Date("2026-08-31T04:00:00.000Z"),
              scheduledPayoutAt: new Date("2026-08-31T16:00:00.000Z"),
              periodCanonical: true,
              status: "draft",
              createdBy: owner.id,
              createdAt: now,
              updatedAt: now,
            },
          ])
          .returning({ id: payoutRuns.id });
        if (!lockedPayout || !stalePayout || !payout) {
          throw new Error("test_payout_missing");
        }

        const ownerExpense = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 5_000,
            purchaseDate: "2026-08-26",
            categoryId: "fuel",
            payerType: "company",
            paidByMemberId: null,
          }),
          actorId: owner.id,
          canApprove: true,
          source: "manual",
          now,
        });
        expect(ownerExpense).toEqual(
          expect.objectContaining({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            version: 2,
          }),
        );

        const ownerDumpExpense = await createExpenseSubmissionInTransaction(
          tx,
          {
            submission: parseExpenseSubmission({
              amountCents: 9_141,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "Capital Waste Services",
              payerType: "company",
              paidByMemberId: null,
              dumpDetails: {
                weightStatus: "confirmed",
                facilityName: "Speedway Transfer Station",
                ticketNumber: "697723",
                material: "Construction & Demo",
                grossWeightPounds: 15_780,
                tareWeightPounds: 12_880,
                netWeightPounds: 2_900,
                billedWeightMilliTons: 1_450,
                unitRateCentsPerTon: 5_000,
                reviewed: true,
              },
            }),
            actorId: owner.id,
            canApprove: true,
            source: "receipt_scan",
            now,
          },
        );
        expect(ownerDumpExpense).toEqual(
          expect.objectContaining({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            dumpDetailsRecorded: true,
          }),
        );
        expect(
          await tx
            .select({
              expenseId: expenseDumpDetails.expenseId,
              weightStatus: expenseDumpDetails.weightStatus,
              netWeightPounds: expenseDumpDetails.netWeightPounds,
              confirmedBy: expenseDumpDetails.confirmedBy,
            })
            .from(expenseDumpDetails)
            .where(
              eq(expenseDumpDetails.expenseId, ownerDumpExpense.expenseId),
            ),
        ).toEqual([
          {
            expenseId: ownerDumpExpense.expenseId,
            weightStatus: "confirmed",
            netWeightPounds: 2_900,
            confirmedBy: owner.id,
          },
        ]);

        const pendingDumpExpense = await createExpenseSubmissionInTransaction(
          tx,
          {
            submission: parseExpenseSubmission({
              amountCents: 7_500,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "County Transfer Station",
              payerType: "company",
              paidByMemberId: null,
              dumpDetails: {
                weightStatus: "unreadable",
                facilityName: "County Transfer Station",
                ticketNumber: "CREW-001",
                material: "Mixed debris",
                grossWeightPounds: 9_000,
                tareWeightPounds: 6_000,
                netWeightPounds: null,
                billedWeightMilliTons: 1_500,
                unitRateCentsPerTon: 5_000,
                reviewed: true,
              },
            }),
            actorId: crew.id,
            canApprove: false,
            source: "receipt_scan",
            now,
          },
        );
        expect(pendingDumpExpense).toEqual(
          expect.objectContaining({
            lifecycleStatus: "draft",
            reviewStatus: "pending",
            dumpDetailsRecorded: true,
          }),
        );
        const approvedDumpExpense = await reviewExpenseSubmissionInTransaction(
          tx,
          {
            expenseId: pendingDumpExpense.expenseId,
            reviewerId: owner.id,
            expectedVersion: 1,
            decision: {
              decision: "approve",
              reason: "Confirmed printed scale weight",
              dumpDetails: {
                weightStatus: "confirmed",
                facilityName: "County Transfer Station",
                ticketNumber: "CREW-001",
                material: "Mixed debris",
                grossWeightPounds: 9_000,
                tareWeightPounds: 6_000,
                netWeightPounds: 3_000,
                billedWeightMilliTons: 1_500,
                unitRateCentsPerTon: 5_000,
                reviewed: true,
              },
            },
            now: new Date(now.getTime() + 500),
          },
        );
        expect(approvedDumpExpense).toEqual(
          expect.objectContaining({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            dumpDetailsRecorded: true,
          }),
        );
        expect(
          await tx
            .select({
              weightStatus: expenseDumpDetails.weightStatus,
              netWeightPounds: expenseDumpDetails.netWeightPounds,
              confirmedBy: expenseDumpDetails.confirmedBy,
            })
            .from(expenseDumpDetails)
            .where(
              eq(expenseDumpDetails.expenseId, pendingDumpExpense.expenseId),
            ),
        ).toEqual([
          {
            weightStatus: "confirmed",
            netWeightPounds: 3_000,
            confirmedBy: owner.id,
          },
        ]);

        const falsePositiveScale = await createExpenseSubmissionInTransaction(
          tx,
          {
            submission: parseExpenseSubmission({
              amountCents: 2_500,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "Ordinary Store",
              payerType: "company",
              paidByMemberId: null,
              dumpDetails: {
                weightStatus: "unreadable",
                facilityName: "AI false positive",
                ticketNumber: "FALSE-001",
                material: null,
                grossWeightPounds: null,
                tareWeightPounds: null,
                netWeightPounds: null,
                billedWeightMilliTons: null,
                unitRateCentsPerTon: null,
                reviewed: true,
              },
            }),
            actorId: crew.id,
            canApprove: false,
            source: "receipt_scan",
            now: new Date(now.getTime() + 600),
          },
        );
        const reclassified = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: falsePositiveScale.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: {
            decision: "approve",
            reason: "Owner confirmed this is an ordinary receipt",
            scaleTicketDisposition: "not_scale_ticket",
          },
          now: new Date(now.getTime() + 700),
        });
        expect(reclassified).toMatchObject({
          lifecycleStatus: "posted",
          dumpDetailsRecorded: false,
        });
        expect(
          await tx
            .select({ expenseId: expenseDumpDetails.expenseId })
            .from(expenseDumpDetails)
            .where(
              eq(expenseDumpDetails.expenseId, falsePositiveScale.expenseId),
            ),
        ).toEqual([]);

        const pendingAcrossRollback =
          await createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 3_000,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "Rollback Transfer",
              payerType: "company",
              paidByMemberId: null,
              dumpDetails: {
                weightStatus: "confirmed",
                facilityName: "Rollback Transfer",
                ticketNumber: "ROLLBACK-001",
                material: "Mixed debris",
                grossWeightPounds: 8_000,
                tareWeightPounds: 6_000,
                netWeightPounds: 2_000,
                billedWeightMilliTons: 1_000,
                unitRateCentsPerTon: 3_000,
                reviewed: true,
              },
            }),
            actorId: crew.id,
            canApprove: false,
            source: "receipt_scan",
            now: new Date(now.getTime() + 800),
          });
        const approvedWhileFlagOff = await reviewExpenseSubmissionInTransaction(
          tx,
          {
            expenseId: pendingAcrossRollback.expenseId,
            reviewerId: owner.id,
            expectedVersion: 1,
            decision: { decision: "approve", reason: null },
            dumpTicketsEnabled: false,
            now: new Date(now.getTime() + 900),
          },
        );
        expect(approvedWhileFlagOff).toMatchObject({
          lifecycleStatus: "posted",
          dumpDetailsRecorded: true,
        });

        const pendingPersonal = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 7_500,
            purchaseDate: "2026-08-26",
            categoryId: "equipment",
            allocations: [
              { categoryId: "equipment", amountCents: 5_000 },
              { categoryId: "supplies", amountCents: 2_500 },
            ],
            vendor: "Local Supply",
            payerType: "personal",
            paidByMemberId: crew.id,
          }),
          actorId: crew.id,
          canApprove: false,
          source: "manual",
          now,
        });
        expect(pendingPersonal).toEqual(
          expect.objectContaining({
            lifecycleStatus: "draft",
            reviewStatus: "pending",
            reimbursementClaimId: null,
          }),
        );

        const approved = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pendingPersonal.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: { decision: "approve", reason: null },
          now: new Date(now.getTime() + 1_000),
        });
        expect(approved).toEqual(
          expect.objectContaining({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            reimbursementStatus: "attached",
          }),
        );

        const [claim] = await tx
          .select()
          .from(expenseReimbursementClaims)
          .where(
            eq(expenseReimbursementClaims.expenseId, pendingPersonal.expenseId),
          );
        expect(claim).toEqual(
          expect.objectContaining({
            amountCents: 7_500,
            memberId: crew.id,
            status: "attached",
            payoutRunId: payout.id,
          }),
        );
        const adjustments = await tx
          .select()
          .from(payoutRunAdjustments)
          .where(
            and(
              eq(payoutRunAdjustments.payoutRunId, payout.id),
              eq(payoutRunAdjustments.expenseId, pendingPersonal.expenseId),
            ),
          );
        expect(adjustments).toHaveLength(1);
        expect(adjustments[0]).toEqual(
          expect.objectContaining({
            kind: "reimbursement",
            amountCents: 7_500,
          }),
        );
        expect(
          await tx
            .select({ id: payoutRunAdjustments.id })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, stalePayout.id)),
        ).toHaveLength(0);
        expect(
          await tx
            .select({ id: payoutRunAdjustments.id })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, lockedPayout.id)),
        ).toHaveLength(0);
        expect(
          await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.id, pendingPersonal.expenseId)),
        ).toHaveLength(1);
        expect(
          await tx
            .select({ amountCents: expenseAllocations.amountCents })
            .from(expenseAllocations)
            .where(eq(expenseAllocations.expenseId, pendingPersonal.expenseId)),
        ).toEqual(
          expect.arrayContaining([
            { amountCents: 5_000 },
            { amountCents: 2_500 },
          ]),
        );

        const pendingCorrected = await createExpenseSubmissionInTransaction(
          tx,
          {
            submission: parseExpenseSubmission({
              amountCents: 3_400,
              purchaseDate: "2026-08-26",
              categoryId: "equipment",
              vendor: "Review Me Supply",
              payerType: "company",
              paidByMemberId: null,
            }),
            actorId: crew.id,
            canApprove: false,
            source: "receipt_scan",
            now,
          },
        );
        const corrected = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pendingCorrected.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: {
            decision: "approve",
            reason: "Corrected from receipt details",
            categoryId: "supplies",
            allocations: [
              { categoryId: "supplies", amountCents: 2_000 },
              { categoryId: "office_admin", amountCents: 1_400 },
            ],
            lockVendorRule: true,
          },
          now: new Date(now.getTime() + 1_500),
        });
        expect(corrected).toEqual(
          expect.objectContaining({
            categoryId: "supplies",
            category: "Supplies",
            lifecycleStatus: "posted",
          }),
        );
        expect(
          await tx
            .select({
              categoryId: expenseAllocations.categoryId,
              amountCents: expenseAllocations.amountCents,
            })
            .from(expenseAllocations)
            .where(
              eq(expenseAllocations.expenseId, pendingCorrected.expenseId),
            ),
        ).toEqual(
          expect.arrayContaining([
            { categoryId: "supplies", amountCents: 2_000 },
            { categoryId: "office_admin", amountCents: 1_400 },
          ]),
        );
        expect(
          await tx
            .select({
              categoryId: expenseVendorCategoryRules.categoryId,
              ownerLocked: expenseVendorCategoryRules.ownerLocked,
              lockedBy: expenseVendorCategoryRules.lockedBy,
            })
            .from(expenseVendorCategoryRules)
            .where(
              eq(
                expenseVendorCategoryRules.normalizedVendor,
                "review me supply",
              ),
            ),
        ).toEqual(
          expect.arrayContaining([
            {
              categoryId: "supplies",
              ownerLocked: true,
              lockedBy: owner.id,
            },
          ]),
        );

        const pendingRejected = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 1_200,
            purchaseDate: "2026-08-26",
            categoryId: "meals",
            payerType: "company",
            paidByMemberId: null,
          }),
          actorId: crew.id,
          canApprove: false,
          source: "manual",
          now,
        });
        const rejected = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pendingRejected.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: { decision: "reject", reason: "Receipt total is unclear" },
          now: new Date(now.getTime() + 2_000),
        });
        expect(rejected).toEqual(
          expect.objectContaining({
            lifecycleStatus: "draft",
            reviewStatus: "rejected",
          }),
        );

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("applies the same scale-ticket duplicate gate to manual owner and crew submissions", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T14:00:00.000Z");
        const [owner, crew] = await tx
          .insert(teamMembers)
          .values([
            { name: "Manual duplicate owner", active: true },
            { name: "Manual duplicate crew", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !crew)
          throw new Error("manual_duplicate_members_missing");
        const dumpDetails = {
          weightStatus: "confirmed" as const,
          facilityName: "Café & Sons Transfer",
          ticketNumber: "A&B É123",
          material: "Const & Demo",
          grossWeightPounds: 15_780,
          tareWeightPounds: 12_880,
          netWeightPounds: 2_900,
          billedWeightMilliTons: 1_450,
          unitRateCentsPerTon: 5_000,
          reviewed: true as const,
        };
        const submission = parseExpenseSubmission({
          amountCents: 9_141,
          purchaseDate: "2026-08-27",
          categoryId: "dump_fees",
          vendor: "Capital Waste Services",
          payerType: "company",
          paidByMemberId: null,
          dumpDetails,
        });
        const matchingSubmission = parseExpenseSubmission({
          ...submission,
          dumpDetails: {
            ...dumpDetails,
            facilityName: "Cafe and Sons Transfer",
            ticketNumber: "A and B E123",
          },
        });
        const original = await createExpenseSubmissionInTransaction(tx, {
          submission,
          actorId: owner.id,
          canApprove: true,
          source: "manual",
          now,
        });

        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: matchingSubmission,
            actorId: owner.id,
            canApprove: true,
            source: "manual",
            now: new Date(now.getTime() + 100),
          }),
        ).rejects.toMatchObject({
          code: "invalid",
          fieldErrors: {
            exactDuplicateOverrideReason:
              "Enter at least 10 characters explaining why this is not a duplicate expense.",
          },
        });
        const ownerOverrideReason =
          "Separate disposal charge verified against the scale ticket";
        const ownerDuplicate = await createExpenseSubmissionInTransaction(tx, {
          submission: matchingSubmission,
          actorId: owner.id,
          canApprove: true,
          source: "manual",
          duplicateOverrideReason: ownerOverrideReason,
          now: new Date(now.getTime() + 200),
        });
        expect(ownerDuplicate).toMatchObject({
          lifecycleStatus: "posted",
          duplicateOverrideRecorded: true,
          scaleTicketDuplicateOfExpenseId: original.expenseId,
        });
        expect(
          await tx
            .select({ reviewReason: expenses.reviewReason })
            .from(expenses)
            .where(eq(expenses.id, ownerDuplicate.expenseId)),
        ).toEqual([{ reviewReason: ownerOverrideReason }]);

        const pending = await createExpenseSubmissionInTransaction(tx, {
          submission: matchingSubmission,
          actorId: crew.id,
          canApprove: false,
          source: "manual",
          now: new Date(now.getTime() + 300),
        });
        expect(pending).toMatchObject({
          lifecycleStatus: "draft",
          reviewStatus: "pending",
          duplicateOverrideRecorded: false,
        });
        await expect(
          reviewExpenseSubmissionInTransaction(tx, {
            expenseId: pending.expenseId,
            reviewerId: owner.id,
            expectedVersion: 1,
            decision: { decision: "approve", reason: null },
            now: new Date(now.getTime() + 400),
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        const approved = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pending.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: {
            decision: "approve",
            reason: "Owner verified this is a separate disposal charge",
          },
          now: new Date(now.getTime() + 500),
        });
        expect(approved).toMatchObject({
          lifecycleStatus: "posted",
        });
        expect(approved.scaleTicketDuplicateOfExpenseId).not.toBeNull();

        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              ...matchingSubmission,
              dumpDetails: {
                ...dumpDetails,
                facilityName: "Different Transfer Station",
                ticketNumber: "UNIQUE-9000",
              },
            }),
            actorId: owner.id,
            canApprove: true,
            source: "manual",
            duplicateOverrideReason: "No matching ticket exists for this one",
            now: new Date(now.getTime() + 600),
          }),
        ).rejects.toMatchObject({
          code: "invalid",
          fieldErrors: {
            exactDuplicateOverrideReason: "Remove the override reason.",
          },
        });

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});
