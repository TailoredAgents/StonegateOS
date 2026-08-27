import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
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
  attachApprovedReimbursementClaimsToDraftPayout,
  createExpenseSubmissionInTransaction,
  markAttachedReimbursementClaimsPaid,
  parseExpenseSubmission,
} from "@/lib/expense-submissions";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;
const ROLLBACK = new Error("expense_reimbursement_payout_test_rollback");

async function expectMutationFailure(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    if (!(error instanceof TeamMutationFailure)) throw error;
    expect(error.code).toBe("conflict");
    expect(error.message).toContain(expectedMessage);
    return;
  }
  throw new Error(`Expected mutation failure containing: ${expectedMessage}`);
}

async function createPayoutRun(
  tx: TeamMutationTransaction,
  input: {
    ownerId: string;
    status: "draft" | "locked";
    periodStart: Date;
    periodEnd: Date;
    scheduledPayoutAt: Date;
    now: Date;
  },
): Promise<string> {
  const [run] = await tx
    .insert(payoutRuns)
    .values({
      timezone: "America/New_York",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      scheduledPayoutAt: input.scheduledPayoutAt,
      periodCanonical: true,
      status: input.status,
      createdBy: input.ownerId,
      lockedAt: input.status === "locked" ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: payoutRuns.id });
  if (!run) throw new Error("test_payout_run_missing");
  return run.id;
}

async function createAttachedPersonalExpense(
  tx: TeamMutationTransaction,
  input: { ownerId: string; employeeId: string; now: Date },
) {
  return createExpenseSubmissionInTransaction(tx, {
    submission: parseExpenseSubmission({
      amountCents: 7_500,
      purchaseDate: "2026-08-26",
      categoryId: "equipment",
      vendor: null,
      payerType: "personal",
      paidByMemberId: input.employeeId,
    }),
    actorId: input.ownerId,
    submittedById: input.employeeId,
    canApprove: true,
    source: "manual",
    now: input.now,
  });
}

async function lockPayoutRun(
  tx: TeamMutationTransaction,
  payoutRunId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(payoutRuns)
    .set({ status: "locked", lockedAt: now, updatedAt: now })
    .where(and(eq(payoutRuns.id, payoutRunId), eq(payoutRuns.status, "draft")));
}

describeOrSkip("expense reimbursement payout transitions", () => {
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

  it("skips locked payroll, attaches once to the next draft, and marks the claim paid once", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T14:00:00.000Z");
        const lockedAt = new Date("2026-08-27T14:05:00.000Z");
        const paidAt = new Date("2026-08-27T14:10:00.000Z");
        const [owner, employee] = await tx
          .insert(teamMembers)
          .values([
            { name: "Reimbursement transition owner", active: true },
            { name: "Reimbursement transition employee", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !employee) throw new Error("test_members_missing");

        const lockedRunId = await createPayoutRun(tx, {
          ownerId: owner.id,
          status: "locked",
          periodStart: new Date("2026-08-10T04:00:00.000Z"),
          periodEnd: new Date("2026-08-17T04:00:00.000Z"),
          scheduledPayoutAt: new Date("2026-08-17T16:00:00.000Z"),
          now,
        });
        const draftRunId = await createPayoutRun(tx, {
          ownerId: owner.id,
          status: "draft",
          periodStart: new Date("2026-08-24T04:00:00.000Z"),
          periodEnd: new Date("2026-08-31T04:00:00.000Z"),
          scheduledPayoutAt: new Date("2026-08-31T16:00:00.000Z"),
          now,
        });

        const created = await createAttachedPersonalExpense(tx, {
          ownerId: owner.id,
          employeeId: employee.id,
          now,
        });
        expect(created.reimbursementStatus).toBe("attached");
        if (!created.reimbursementClaimId) {
          throw new Error("test_reimbursement_claim_missing");
        }

        const [claim] = await tx
          .select()
          .from(expenseReimbursementClaims)
          .where(
            eq(expenseReimbursementClaims.id, created.reimbursementClaimId),
          );
        expect(claim).toMatchObject({
          expenseId: created.expenseId,
          status: "attached",
          payoutRunId: draftRunId,
          amountCents: 7_500,
        });
        expect(
          await tx
            .select({ id: payoutRunAdjustments.id })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, lockedRunId)),
        ).toEqual([]);

        await expect(
          attachApprovedReimbursementClaimsToDraftPayout(tx, {
            payoutRunId: draftRunId,
            actorId: owner.id,
            now,
          }),
        ).resolves.toEqual([]);
        await lockPayoutRun(tx, draftRunId, lockedAt);
        await expect(
          attachApprovedReimbursementClaimsToDraftPayout(tx, {
            payoutRunId: draftRunId,
            actorId: owner.id,
            now: lockedAt,
          }),
        ).resolves.toEqual([]);

        await tx
          .update(payoutRuns)
          .set({ status: "paid", paidAt, updatedAt: paidAt })
          .where(
            and(eq(payoutRuns.id, draftRunId), eq(payoutRuns.status, "locked")),
          );
        await expect(
          markAttachedReimbursementClaimsPaid(tx, {
            payoutRunId: draftRunId,
            paidAt,
          }),
        ).resolves.toBe(1);
        await expect(
          markAttachedReimbursementClaimsPaid(tx, {
            payoutRunId: draftRunId,
            paidAt,
          }),
        ).resolves.toBe(0);

        expect(
          await tx
            .select({
              status: expenseReimbursementClaims.status,
              paidAt: expenseReimbursementClaims.paidAt,
              version: expenseReimbursementClaims.version,
            })
            .from(expenseReimbursementClaims)
            .where(
              eq(expenseReimbursementClaims.id, created.reimbursementClaimId),
            ),
        ).toEqual([{ status: "paid", paidAt, version: 3 }]);
        expect(
          await tx
            .select({ id: payoutRunAdjustments.id })
            .from(payoutRunAdjustments)
            .where(eq(payoutRunAdjustments.payoutRunId, draftRunId)),
        ).toHaveLength(1);
        expect(
          await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.id, created.expenseId)),
        ).toHaveLength(1);

        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("refuses correction once an attached reimbursement payout is locked", async () => {
    await expectMutationFailure(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T14:00:00.000Z");
        const [owner, employee] = await tx
          .insert(teamMembers)
          .values([
            { name: "Locked correction owner", active: true },
            { name: "Locked correction employee", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !employee) throw new Error("test_members_missing");
        const payoutRunId = await createPayoutRun(tx, {
          ownerId: owner.id,
          status: "draft",
          periodStart: new Date("2026-08-24T04:00:00.000Z"),
          periodEnd: new Date("2026-08-31T04:00:00.000Z"),
          scheduledPayoutAt: new Date("2026-08-31T16:00:00.000Z"),
          now,
        });
        const created = await createAttachedPersonalExpense(tx, {
          ownerId: owner.id,
          employeeId: employee.id,
          now,
        });
        await lockPayoutRun(
          tx,
          payoutRunId,
          new Date("2026-08-27T14:05:00.000Z"),
        );
        const [existing] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, created.expenseId))
          .for("update");
        if (!existing) throw new Error("test_expense_missing");

        await createManagedExpenseCorrection(tx, {
          existing,
          replacement: {
            amountCents: 8_000,
            category: "Fuel",
            vendor: null,
            memo: null,
            method: null,
            paidAt: existing.paidAt,
            coverageStartAt: null,
            coverageEndAt: null,
          },
          actorId: owner.id,
          reason: "Receipt total correction after payroll lock",
          now: new Date("2026-08-27T14:10:00.000Z"),
        });
      }),
      "locked payout",
    );
  });

  it("refuses void once the reimbursement has been paid", async () => {
    await expectMutationFailure(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T14:00:00.000Z");
        const paidAt = new Date("2026-08-27T14:10:00.000Z");
        const [owner, employee] = await tx
          .insert(teamMembers)
          .values([
            { name: "Paid void owner", active: true },
            { name: "Paid void employee", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !employee) throw new Error("test_members_missing");
        const payoutRunId = await createPayoutRun(tx, {
          ownerId: owner.id,
          status: "draft",
          periodStart: new Date("2026-08-24T04:00:00.000Z"),
          periodEnd: new Date("2026-08-31T04:00:00.000Z"),
          scheduledPayoutAt: new Date("2026-08-31T16:00:00.000Z"),
          now,
        });
        const created = await createAttachedPersonalExpense(tx, {
          ownerId: owner.id,
          employeeId: employee.id,
          now,
        });
        await lockPayoutRun(
          tx,
          payoutRunId,
          new Date("2026-08-27T14:05:00.000Z"),
        );
        await tx
          .update(payoutRuns)
          .set({ status: "paid", paidAt, updatedAt: paidAt })
          .where(
            and(
              eq(payoutRuns.id, payoutRunId),
              eq(payoutRuns.status, "locked"),
            ),
          );
        await markAttachedReimbursementClaimsPaid(tx, {
          payoutRunId,
          paidAt,
        });
        const [existing] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, created.expenseId))
          .for("update");
        if (!existing) throw new Error("test_expense_missing");

        await createManagedExpenseVoid(tx, {
          existing,
          actorId: owner.id,
          reason: "Attempted void after employee was reimbursed",
          now: new Date("2026-08-27T14:15:00.000Z"),
        });
      }),
      "already reimbursed",
    );
  });
});
