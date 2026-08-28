import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  expenseAllocations,
  expenseDumpDetails,
  expenseReimbursementClaims,
  expenses,
  getDb,
  payoutRunAdjustments,
  payoutRuns,
  teamMembers,
} from "@/db";
import {
  createManagedExpenseCorrection,
  createManagedExpenseVoid,
} from "@/lib/expense-managed-lifecycle";
import { createExpenseFixedCost } from "@/lib/expense-fixed-costs";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
} from "@/lib/expense-submissions";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

function databaseErrorText(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) messages.push(current.message);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages.join("\n");
}

describeOrSkip("managed V2 expense correction lifecycle", () => {
  const ROLLBACK = new Error("managed_expense_lifecycle_test_rollback");
  const originalReimbursementFlag =
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"];
  const originalFixedCostFlag = process.env["EXPENSE_FIXED_COSTS_ENABLED"];

  beforeAll(() => {
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = "1";
    process.env["EXPENSE_FIXED_COSTS_ENABLED"] = "1";
  });

  afterAll(async () => {
    if (originalReimbursementFlag === undefined) {
      delete process.env["EXPENSE_REIMBURSEMENT_ENABLED"];
    } else {
      process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = originalReimbursementFlag;
    }
    if (originalFixedCostFlag === undefined) {
      delete process.env["EXPENSE_FIXED_COSTS_ENABLED"];
    } else {
      process.env["EXPENSE_FIXED_COSTS_ENABLED"] = originalFixedCostFlag;
    }
    await closeDbForTests();
  });

  it("preserves signed allocations and moves an editable reimbursement without duplicating it", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const createdAt = new Date("2026-08-27T14:00:00.000Z");
        const correctedAt = new Date("2026-08-27T14:05:00.000Z");
        const voidedAt = new Date("2026-08-27T14:10:00.000Z");
        const [owner, employee] = await tx
          .insert(teamMembers)
          .values([
            { name: "Lifecycle owner", active: true },
            { name: "Lifecycle employee", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !employee) throw new Error("test_members_missing");

        const [payout] = await tx
          .insert(payoutRuns)
          .values({
            timezone: "America/New_York",
            periodStart: new Date("2026-08-24T04:00:00.000Z"),
            periodEnd: new Date("2026-08-31T04:00:00.000Z"),
            scheduledPayoutAt: new Date("2026-08-31T16:00:00.000Z"),
            periodCanonical: true,
            status: "draft",
            createdBy: owner.id,
            createdAt,
            updatedAt: createdAt,
          })
          .returning({ id: payoutRuns.id });
        if (!payout) throw new Error("test_payout_missing");

        const created = await createExpenseSubmissionInTransaction(tx, {
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
            paidByMemberId: employee.id,
          }),
          actorId: owner.id,
          submittedById: employee.id,
          canApprove: true,
          source: "manual",
          now: createdAt,
        });
        expect(created.reimbursementStatus).toBe("attached");

        const [existing] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, created.expenseId))
          .for("update");
        if (!existing) throw new Error("test_expense_missing");
        const correction = await createManagedExpenseCorrection(tx, {
          existing,
          replacement: {
            amountCents: 8_000,
            category: "Fuel",
            vendor: "Local Supply",
            memo: "Corrected total and category",
            method: "card",
            paidAt: existing.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: owner.id,
          reason: "Receipt review found a different total",
          now: correctedAt,
        });
        expect(correction.allocationStrategy).toBe("single_category");
        expect(correction.reimbursementStatus).toBe("attached");

        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "corrected",
            correctedAt,
            correctedBy: owner.id,
            correctionReason: "Receipt review found a different total",
            correctedByExpenseId: correction.replacement.id,
            version: existing.version + 1,
            updatedAt: correctedAt,
          })
          .where(
            and(
              eq(expenses.id, existing.id),
              eq(expenses.version, existing.version),
            ),
          );

        expect(
          await tx
            .select({
              categoryId: expenseAllocations.categoryId,
              amountCents: expenseAllocations.amountCents,
            })
            .from(expenseAllocations)
            .where(eq(expenseAllocations.expenseId, correction.reversal.id)),
        ).toEqual(
          expect.arrayContaining([
            { categoryId: "equipment", amountCents: -5_000 },
            { categoryId: "supplies", amountCents: -2_500 },
          ]),
        );
        expect(
          await tx
            .select({
              categoryId: expenseAllocations.categoryId,
              amountCents: expenseAllocations.amountCents,
            })
            .from(expenseAllocations)
            .where(eq(expenseAllocations.expenseId, correction.replacement.id)),
        ).toEqual([{ categoryId: "fuel", amountCents: 8_000 }]);

        const [movedClaim] = await tx
          .select()
          .from(expenseReimbursementClaims)
          .where(
            eq(expenseReimbursementClaims.expenseId, correction.replacement.id),
          );
        expect(movedClaim).toMatchObject({
          id: correction.reimbursementClaimId,
          amountCents: 8_000,
          status: "attached",
          payoutRunId: payout.id,
        });
        if (!movedClaim) throw new Error("moved_claim_missing");
        expect(
          await tx
            .select({
              amountCents: payoutRunAdjustments.amountCents,
              expenseId: payoutRunAdjustments.expenseId,
            })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, payout.id)),
        ).toEqual([
          { amountCents: 8_000, expenseId: correction.replacement.id },
        ]);

        const [replacement] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, correction.replacement.id))
          .for("update");
        if (!replacement) throw new Error("replacement_missing");
        const managedVoid = await createManagedExpenseVoid(tx, {
          existing: replacement,
          actorId: owner.id,
          reason: "Purchase was refunded before payroll locked",
          now: voidedAt,
        });
        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "voided",
            voidedAt,
            voidedBy: owner.id,
            voidReason: "Purchase was refunded before payroll locked",
            version: replacement.version + 1,
            updatedAt: voidedAt,
          })
          .where(
            and(
              eq(expenses.id, replacement.id),
              eq(expenses.version, replacement.version),
            ),
          );
        expect(managedVoid.reimbursementStatus).toBe("rejected");
        expect(
          await tx
            .select({ status: expenseReimbursementClaims.status })
            .from(expenseReimbursementClaims)
            .where(eq(expenseReimbursementClaims.id, movedClaim.id)),
        ).toEqual([{ status: "rejected" }]);
        expect(
          await tx
            .select({ id: payoutRunAdjustments.id })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, payout.id)),
        ).toEqual([]);

        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected the verification transaction to roll back.");
  });

  it("preserves, replaces, or explicitly removes dump facts only on positive correction rows", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const createdAt = new Date("2026-08-27T14:00:00.000Z");
        const correctedAt = new Date("2026-08-27T15:00:00.000Z");
        const replacedAt = new Date("2026-08-27T16:00:00.000Z");
        const [submitter, correctingOwner] = await tx
          .insert(teamMembers)
          .values([
            { name: "Original ticket reviewer", active: true },
            { name: "Correction ticket reviewer", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!submitter || !correctingOwner) {
          throw new Error("dump_correction_members_missing");
        }

        const created = await createExpenseSubmissionInTransaction(tx, {
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
              material: "Const & Demo",
              grossWeightPounds: 15_780,
              tareWeightPounds: 12_880,
              netWeightPounds: 2_900,
              billedWeightMilliTons: 1_450,
              unitRateCentsPerTon: 5_000,
              reviewed: true,
            },
          }),
          actorId: submitter.id,
          canApprove: true,
          source: "receipt_scan",
          now: createdAt,
        });
        const duplicateTarget = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 8_000,
            purchaseDate: "2026-08-27",
            categoryId: "dump_fees",
            vendor: "Another Transfer Operator",
            payerType: "company",
            paidByMemberId: null,
            dumpDetails: {
              weightStatus: "confirmed",
              facilityName: "North County Transfer Station",
              ticketNumber: "DUP-123",
              material: "Mixed debris",
              grossWeightPounds: 10_000,
              tareWeightPounds: 7_000,
              netWeightPounds: 3_000,
              billedWeightMilliTons: 1_500,
              unitRateCentsPerTon: 5_000,
              reviewed: true,
            },
          }),
          actorId: submitter.id,
          canApprove: true,
          source: "receipt_scan",
          now: createdAt,
        });
        const [existing] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, created.expenseId))
          .for("update");
        if (!existing) throw new Error("dump_original_missing");

        const preserved = await createManagedExpenseCorrection(tx, {
          existing,
          replacement: {
            amountCents: 9_141,
            category: "Dump Fees",
            vendor: "Capital Waste Services",
            memo: "Corrected memo only",
            method: "card",
            paidAt: existing.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: correctingOwner.id,
          reason: "Corrected memo without changing ticket facts",
          now: correctedAt,
        });
        expect(preserved.dumpDetailsRecorded).toBe(true);
        expect(
          await tx
            .select({ expenseId: expenseDumpDetails.expenseId })
            .from(expenseDumpDetails)
            .where(eq(expenseDumpDetails.expenseId, preserved.reversal.id)),
        ).toEqual([]);
        expect(
          await tx
            .select({
              confirmedBy: expenseDumpDetails.confirmedBy,
              confirmedAt: expenseDumpDetails.confirmedAt,
              netWeightPounds: expenseDumpDetails.netWeightPounds,
            })
            .from(expenseDumpDetails)
            .where(eq(expenseDumpDetails.expenseId, preserved.replacement.id)),
        ).toEqual([
          {
            confirmedBy: submitter.id,
            confirmedAt: createdAt,
            netWeightPounds: 2_900,
          },
        ]);

        const [preservedExpense] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, preserved.replacement.id))
          .for("update");
        if (!preservedExpense) throw new Error("preserved_expense_missing");
        const replaced = await createManagedExpenseCorrection(tx, {
          existing: preservedExpense,
          replacement: {
            amountCents: 9_141,
            category: "Dump Fees",
            vendor: "Capital Waste Services",
            memo: "Corrected printed weight",
            method: "card",
            paidAt: preservedExpense.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: correctingOwner.id,
          reason: "Corrected the printed ticket weight",
          now: replacedAt,
          dumpDetails: {
            weightStatus: "confirmed",
            facilityName: "Speedway Transfer Station",
            ticketNumber: "697723",
            material: "Const & Demo",
            grossWeightPounds: 15_780,
            tareWeightPounds: 12_880,
            netWeightPounds: 2_950,
            billedWeightMilliTons: 1_450,
            unitRateCentsPerTon: 5_000,
            reviewed: true,
          },
        });
        expect(
          await tx
            .select({
              confirmedBy: expenseDumpDetails.confirmedBy,
              confirmedAt: expenseDumpDetails.confirmedAt,
              netWeightPounds: expenseDumpDetails.netWeightPounds,
            })
            .from(expenseDumpDetails)
            .where(eq(expenseDumpDetails.expenseId, replaced.replacement.id)),
        ).toEqual([
          {
            confirmedBy: correctingOwner.id,
            confirmedAt: replacedAt,
            netWeightPounds: 2_950,
          },
        ]);

        const [replacedExpense] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, replaced.replacement.id))
          .for("update");
        if (!replacedExpense) throw new Error("replaced_expense_missing");
        const duplicateCorrectionDetails = {
          weightStatus: "confirmed" as const,
          facilityName: " north county transfer-station ",
          ticketNumber: "DUP 123",
          material: "Mixed debris",
          grossWeightPounds: 10_000,
          tareWeightPounds: 7_000,
          netWeightPounds: 3_000,
          billedWeightMilliTons: 1_500,
          unitRateCentsPerTon: 5_000,
          reviewed: true as const,
        };
        await expect(
          createManagedExpenseCorrection(tx, {
            existing: replacedExpense,
            replacement: {
              amountCents: 9_141,
              category: "Dump Fees",
              vendor: "Capital Waste Services",
              memo: "Changed ticket",
              method: "card",
              paidAt: replacedExpense.paidAt,
              coverageStartAt: null,
              coverageEndAt: null,
            },
            actorId: correctingOwner.id,
            reason: "short",
            now: new Date(replacedAt.getTime() + 250),
            dumpDetails: duplicateCorrectionDetails,
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        const duplicateOverride = await createManagedExpenseCorrection(tx, {
          existing: replacedExpense,
          replacement: {
            amountCents: 9_141,
            category: "Dump Fees",
            vendor: "Capital Waste Services",
            memo: "Changed ticket after owner review",
            method: "card",
            paidAt: replacedExpense.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: correctingOwner.id,
          reason: "Verified this is a separate disposal charge",
          now: new Date(replacedAt.getTime() + 500),
          dumpDetails: duplicateCorrectionDetails,
        });
        expect(duplicateOverride.scaleTicketDuplicateOfExpenseId).toBe(
          duplicateTarget.expenseId,
        );
        const [duplicateOverrideExpense] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, duplicateOverride.replacement.id))
          .for("update");
        if (!duplicateOverrideExpense) {
          throw new Error("duplicate_override_expense_missing");
        }
        const fuelReplacement = {
          amountCents: 9_141,
          category: "Fuel",
          vendor: "Capital Waste Services",
          memo: "Category corrected",
          method: "card",
          paidAt: duplicateOverrideExpense.paidAt,
          coverageStartAt: null,
          coverageEndAt: null,
        };
        await expect(
          createManagedExpenseCorrection(tx, {
            existing: duplicateOverrideExpense,
            replacement: fuelReplacement,
            actorId: correctingOwner.id,
            reason: "Changing away from Dump Fees",
            now: new Date(replacedAt.getTime() + 1_000),
          }),
        ).rejects.toMatchObject({ code: "invalid" });

        const removed = await createManagedExpenseCorrection(tx, {
          existing: duplicateOverrideExpense,
          replacement: fuelReplacement,
          actorId: correctingOwner.id,
          reason: "Changing away from Dump Fees and removing ticket facts",
          now: new Date(replacedAt.getTime() + 2_000),
          dumpDetails: null,
        });
        expect(removed.dumpDetailsRecorded).toBe(false);
        expect(
          await tx
            .select({ expenseId: expenseDumpDetails.expenseId })
            .from(expenseDumpDetails)
            .where(eq(expenseDumpDetails.expenseId, removed.replacement.id)),
        ).toEqual([]);

        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected dump correction verification to roll back.");
  });

  it("preserves a valid coverage link through correction and supports explicit unlink", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const createdAt = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Coverage correction owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("coverage_correction_owner_missing");
        const schedule = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now: createdAt,
          name: "Office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 31_000,
          effectiveStartDate: "2026-08-01",
        });
        const created = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 31_000,
            purchaseDate: "2026-08-26",
            categoryId: "office_admin",
            payerType: "company",
            paidByMemberId: null,
            coveredByFixedCostSeriesId: schedule.seriesId,
          }),
          actorId: owner.id,
          canApprove: true,
          canManageFixedCostCoverage: true,
          source: "receipt_scan",
          now: createdAt,
        });
        const [original] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, created.expenseId))
          .for("update");
        if (!original) throw new Error("coverage_original_missing");

        const firstCorrectionAt = new Date(createdAt.getTime() + 1_000);
        const preserved = await createManagedExpenseCorrection(tx, {
          existing: original,
          replacement: {
            amountCents: 31_000,
            category: "Office/Admin",
            vendor: "Landlord",
            memo: "Corrected memo",
            method: "ach",
            paidAt: original.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: owner.id,
          reason: "Corrected the supporting details",
          now: firstCorrectionAt,
        });
        expect(preserved.replacement.coveredByFixedCostSeriesId).toBe(
          schedule.seriesId,
        );
        expect(preserved.reversal.coveredByFixedCostSeriesId).toBeNull();
        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "corrected",
            correctedAt: firstCorrectionAt,
            correctedBy: owner.id,
            correctionReason: "Corrected the supporting details",
            correctedByExpenseId: preserved.replacement.id,
            version: original.version + 1,
            updatedAt: firstCorrectionAt,
          })
          .where(eq(expenses.id, original.id));

        const [linkedReplacement] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, preserved.replacement.id))
          .for("update");
        if (!linkedReplacement) throw new Error("linked_replacement_missing");
        const unlinkAt = new Date(createdAt.getTime() + 2_000);
        const unlinked = await createManagedExpenseCorrection(tx, {
          existing: linkedReplacement,
          replacement: {
            amountCents: 31_000,
            category: "Office/Admin",
            vendor: "Landlord",
            memo: "Remove duplicate coverage marker",
            method: "ach",
            paidAt: linkedReplacement.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: owner.id,
          reason: "Fixed cost coverage was selected by mistake",
          now: unlinkAt,
          coveredByFixedCostSeriesId: null,
          canManageFixedCostCoverage: true,
        });
        expect(unlinked.replacement.coveredByFixedCostSeriesId).toBeNull();
        expect(unlinked.reversal.coveredByFixedCostSeriesId).toBeNull();
        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "corrected",
            correctedAt: unlinkAt,
            correctedBy: owner.id,
            correctionReason: "Fixed cost coverage was selected by mistake",
            correctedByExpenseId: unlinked.replacement.id,
            version: linkedReplacement.version + 1,
            updatedAt: unlinkAt,
          })
          .where(eq(expenses.id, linkedReplacement.id));

        expect(
          await tx
            .select({
              id: expenses.id,
              lifecycleStatus: expenses.lifecycleStatus,
              coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
            })
            .from(expenses)
            .where(eq(expenses.id, unlinked.replacement.id)),
        ).toEqual([
          {
            id: unlinked.replacement.id,
            lifecycleStatus: "posted",
            coveredByFixedCostSeriesId: null,
          },
        ]);

        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected coverage correction verification to roll back.");
  });
});
