import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  expenseAllocations,
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
});
