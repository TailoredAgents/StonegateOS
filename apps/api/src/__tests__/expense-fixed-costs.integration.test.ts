import { eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  expenseAllocations,
  expenseFixedCostVersions,
  expenseReimbursementClaims,
  expenses,
  getDb,
  teamMembers,
} from "@/db";
import {
  createExpenseFixedCost,
  readExpenseFixedCosts,
  reviseExpenseFixedCost,
} from "@/lib/expense-fixed-costs";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
  reviewExpenseSubmissionInTransaction,
} from "@/lib/expense-submissions";
import { TeamMutationFailure } from "@/lib/team-mutation";

const describeOrSkip = process.env["DATABASE_URL"] ? describe : describe.skip;

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

describeOrSkip("recurring fixed-cost database workflow", () => {
  const ROLLBACK = new Error("fixed_cost_verification_rollback");
  const originalFixedCostFlag = process.env["EXPENSE_FIXED_COSTS_ENABLED"];
  const originalReimbursementFlag =
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"];

  beforeAll(() => {
    process.env["EXPENSE_FIXED_COSTS_ENABLED"] = "1";
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = "1";
  });

  afterAll(async () => {
    if (originalFixedCostFlag === undefined) {
      delete process.env["EXPENSE_FIXED_COSTS_ENABLED"];
    } else {
      process.env["EXPENSE_FIXED_COSTS_ENABLED"] = originalFixedCostFlag;
    }
    if (originalReimbursementFlag === undefined) {
      delete process.env["EXPENSE_REIMBURSEMENT_ENABLED"];
    } else {
      process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = originalReimbursementFlag;
    }
    await closeDbForTests();
  });

  it("creates, revises, and ends one append-only version chain", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Fixed-cost owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("fixed_cost_owner_missing");

        const created = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now,
          name: "Office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 250_000,
          effectiveStartDate: "2026-08-01",
        });
        const revised = await reviseExpenseFixedCost(tx, {
          actorId: owner.id,
          now: new Date(now.getTime() + 1_000),
          seriesId: created.seriesId,
          action: "revise",
          expectedVersion: created.version,
          name: "Office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 275_000,
          effectiveStartDate: "2026-08-15",
        });
        const ended = await reviseExpenseFixedCost(tx, {
          actorId: owner.id,
          now: new Date(now.getTime() + 2_000),
          seriesId: created.seriesId,
          action: "end",
          expectedVersion: revised.after.version,
          effectiveStartDate: "2026-08-27",
        });

        expect(created.version).toBe(1);
        expect(revised.after).toMatchObject({
          version: 2,
          state: "active",
          monthlyAmountCents: 275_000,
        });
        expect(ended.after).toMatchObject({ version: 3, state: "ended" });
        const beforeRevision = await readExpenseFixedCosts(
          tx as unknown as ReturnType<typeof getDb>,
          "2026-08-14",
        );
        expect(beforeRevision.costs).toEqual([
          expect.objectContaining({
            seriesId: created.seriesId,
            version: 1,
            state: "active",
            monthlyAmountCents: 250_000,
          }),
        ]);
        expect(beforeRevision.summary).toMatchObject({
          activeCount: 1,
          monthlyAmountCents: 250_000,
        });

        const afterRevision = await readExpenseFixedCosts(
          tx as unknown as ReturnType<typeof getDb>,
          "2026-08-20",
        );
        expect(afterRevision.costs).toEqual([
          expect.objectContaining({
            seriesId: created.seriesId,
            version: 2,
            state: "active",
            monthlyAmountCents: 275_000,
          }),
        ]);

        const afterEnd = await readExpenseFixedCosts(
          tx as unknown as ReturnType<typeof getDb>,
          "2026-08-27",
        );
        expect(afterEnd.costs).toEqual([
          expect.objectContaining({
            seriesId: created.seriesId,
            version: 3,
            state: "ended",
          }),
        ]);
        expect(afterEnd.summary).toMatchObject({
          activeCount: 0,
          monthlyAmountCents: 0,
          dailyAccrualCents: 0,
        });
        const versions = await tx
          .select({
            version: expenseFixedCostVersions.version,
            state: expenseFixedCostVersions.state,
          })
          .from(expenseFixedCostVersions)
          .where(eq(expenseFixedCostVersions.seriesId, created.seriesId));
        expect(versions).toEqual(
          expect.arrayContaining([
            { version: 1, state: "active" },
            { version: 2, state: "active" },
            { version: 3, state: "ended" },
          ]),
        );
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected verification transaction to roll back.");
  });

  it("rejects mutation of an existing accounting version", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Fixed-cost immutability owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("fixed_cost_owner_missing");
        const created = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now,
          name: "Software plan",
          categoryId: "software",
          monthlyAmountCents: 10_000,
          effectiveStartDate: "2026-08-01",
        });
        await tx
          .update(expenseFixedCostVersions)
          .set({ name: "Rewritten plan" })
          .where(eq(expenseFixedCostVersions.seriesId, created.seriesId));
      });
    } catch (error) {
      expect(databaseErrorText(error)).toContain(
        "fixed cost accounting records are append-only",
      );
      return;
    }
    throw new Error(
      "Expected append-only database guard to reject the update.",
    );
  });

  it("enforces owner-only exact coverage and owner review linkage", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner, crew] = await tx
          .insert(teamMembers)
          .values([
            { name: "Coverage owner", active: true },
            { name: "Coverage crew", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !crew) throw new Error("coverage_members_missing");

        const schedule = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now,
          name: "Office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 31_000,
          effectiveStartDate: "2026-08-01",
        });
        const reviewSchedule = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now,
          name: "Reviewed office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 31_000,
          effectiveStartDate: "2026-08-01",
        });
        const personalSchedule = await createExpenseFixedCost(tx, {
          actorId: owner.id,
          now,
          name: "Employee-paid office lease",
          categoryId: "office_admin",
          monthlyAmountCents: 31_000,
          effectiveStartDate: "2026-08-01",
        });

        const ownerExpense = await createExpenseSubmissionInTransaction(tx, {
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
          now,
        });
        expect(ownerExpense.coveredByFixedCostSeriesId).toBe(schedule.seriesId);
        expect(
          await tx
            .select({ amountCents: expenseAllocations.amountCents })
            .from(expenseAllocations)
            .where(eq(expenseAllocations.expenseId, ownerExpense.expenseId)),
        ).toEqual([{ amountCents: 31_000 }]);

        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 31_000,
              purchaseDate: "2026-08-26",
              categoryId: "office_admin",
              payerType: "company",
              paidByMemberId: null,
              coveredByFixedCostSeriesId: schedule.seriesId,
            }),
            actorId: crew.id,
            canApprove: false,
            source: "manual",
            now,
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 30_000,
              purchaseDate: "2026-08-26",
              categoryId: "office_admin",
              payerType: "company",
              paidByMemberId: null,
              coveredByFixedCostSeriesId: schedule.seriesId,
            }),
            actorId: owner.id,
            canApprove: true,
            canManageFixedCostCoverage: true,
            source: "manual",
            now,
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 31_000,
              purchaseDate: "2026-08-26",
              categoryId: "software",
              payerType: "company",
              paidByMemberId: null,
              coveredByFixedCostSeriesId: schedule.seriesId,
            }),
            actorId: owner.id,
            canApprove: true,
            canManageFixedCostCoverage: true,
            source: "manual",
            now,
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 31_000,
              purchaseDate: "2026-08-26",
              categoryId: "office_admin",
              allocations: [
                { categoryId: "office_admin", amountCents: 30_000 },
                { categoryId: "software", amountCents: 1_000 },
              ],
              payerType: "company",
              paidByMemberId: null,
              coveredByFixedCostSeriesId: schedule.seriesId,
            }),
            actorId: owner.id,
            canApprove: true,
            canManageFixedCostCoverage: true,
            source: "manual",
            now,
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        await expect(
          createExpenseSubmissionInTransaction(tx, {
            submission: parseExpenseSubmission({
              amountCents: 31_000,
              purchaseDate: "2026-08-25",
              categoryId: "office_admin",
              payerType: "company",
              paidByMemberId: null,
              coveredByFixedCostSeriesId: schedule.seriesId,
            }),
            actorId: owner.id,
            canApprove: true,
            canManageFixedCostCoverage: true,
            source: "manual",
            now,
          }),
        ).rejects.toMatchObject({ code: "conflict" });

        const pending = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 31_000,
            purchaseDate: "2026-08-26",
            categoryId: "office_admin",
            payerType: "company",
            paidByMemberId: null,
          }),
          actorId: crew.id,
          canApprove: false,
          source: "manual",
          now,
        });
        const reviewed = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pending.expenseId,
          reviewerId: owner.id,
          expectedVersion: pending.version,
          decision: {
            decision: "approve",
            reason: null,
            coveredByFixedCostSeriesId: reviewSchedule.seriesId,
          },
          canManageFixedCostCoverage: true,
          now: new Date(now.getTime() + 1_000),
        });
        expect(reviewed.coveredByFixedCostSeriesId).toBe(
          reviewSchedule.seriesId,
        );
        expect(
          await tx
            .select({
              coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
            })
            .from(expenses)
            .where(eq(expenses.id, pending.expenseId)),
        ).toEqual([{ coveredByFixedCostSeriesId: reviewSchedule.seriesId }]);

        const rejectedPending = await createExpenseSubmissionInTransaction(tx, {
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
          expenseId: rejectedPending.expenseId,
          reviewerId: owner.id,
          expectedVersion: rejectedPending.version,
          decision: { decision: "reject", reason: "Not a company expense" },
          now: new Date(now.getTime() + 1_500),
        });
        expect(rejected.coveredByFixedCostSeriesId).toBeNull();
        expect(
          await tx
            .select({
              coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
            })
            .from(expenses)
            .where(eq(expenses.id, rejectedPending.expenseId)),
        ).toEqual([{ coveredByFixedCostSeriesId: null }]);

        const personalPending = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 31_000,
            purchaseDate: "2026-08-26",
            categoryId: "office_admin",
            payerType: "personal",
            paidByMemberId: crew.id,
          }),
          actorId: crew.id,
          canApprove: false,
          source: "receipt_scan",
          now,
        });
        const personalApproved = await reviewExpenseSubmissionInTransaction(
          tx,
          {
            expenseId: personalPending.expenseId,
            reviewerId: owner.id,
            expectedVersion: personalPending.version,
            decision: {
              decision: "approve",
              reason: null,
              coveredByFixedCostSeriesId: personalSchedule.seriesId,
            },
            canManageFixedCostCoverage: true,
            now: new Date(now.getTime() + 1_750),
          },
        );
        expect(personalApproved).toMatchObject({
          coveredByFixedCostSeriesId: personalSchedule.seriesId,
          reimbursementStatus: "approved",
        });
        expect(
          await tx
            .select({ id: expenseReimbursementClaims.id })
            .from(expenseReimbursementClaims)
            .where(
              eq(
                expenseReimbursementClaims.expenseId,
                personalPending.expenseId,
              ),
            ),
        ).toHaveLength(1);

        await expect(
          reviseExpenseFixedCost(tx, {
            actorId: owner.id,
            now: new Date(now.getTime() + 2_000),
            seriesId: schedule.seriesId,
            action: "revise",
            expectedVersion: schedule.version,
            name: "Office lease",
            categoryId: "office_admin",
            monthlyAmountCents: 32_000,
            effectiveStartDate: "2026-08-01",
          }),
        ).rejects.toBeInstanceOf(TeamMutationFailure);

        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected coverage verification to roll back.");
  });
});
