import { eq, sql } from "drizzle-orm";
import { closeDbForTests, expenses, getDb, teamMembers } from "@/db";
import { saveDailyAdSpendDay } from "@/lib/daily-ad-spend";
import { resolveExpenseCategoryAlias } from "@/lib/expense-categories";
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

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(databaseErrorText(error)).toContain(expectedMessage);
    return;
  }
  throw new Error(`Expected database failure containing: ${expectedMessage}`);
}

describeOrSkip("Expense V2 database workflow guards", () => {
  const ROLLBACK = new Error("expense_v2_database_guard_rollback");
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

  it("allows the dedicated ad workflow to correct and reverse its pointer atomically", async () => {
    try {
      await getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Ad guard owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("ad_guard_owner_missing");

        const first = await saveDailyAdSpendDay(tx, {
          businessDate: "2026-08-26",
          facebook: { amountCents: 1_000, version: null },
          google: null,
          actorId: owner.id,
          now,
        });
        const corrected = await saveDailyAdSpendDay(tx, {
          businessDate: "2026-08-26",
          facebook: {
            amountCents: 1_500,
            version: first.facebook?.version ?? null,
          },
          google: null,
          actorId: owner.id,
          now: new Date(now.getTime() + 1_000),
        });
        const zeroed = await saveDailyAdSpendDay(tx, {
          businessDate: "2026-08-26",
          facebook: {
            amountCents: 0,
            version: corrected.facebook?.version ?? null,
          },
          google: null,
          actorId: owner.id,
          now: new Date(now.getTime() + 2_000),
        });

        expect(first.changes[0]?.kind).toBe("posted");
        expect(corrected.changes[0]?.kind).toBe("corrected");
        expect(zeroed.changes[0]?.kind).toBe("reversed_to_zero");
        expect(zeroed.facebook).toMatchObject({
          amountCents: 0,
          expenseId: null,
        });
        await tx.execute(sql`set constraints all immediate`);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected the verification transaction to roll back.");
  });

  it("rejects lifecycle reversal while any reimbursement claim references the expense", async () => {
    await expectDatabaseFailure(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Reimbursement guard owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("reimbursement_guard_owner_missing");
        const created = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 4_000,
            purchaseDate: "2026-08-26",
            categoryId: "fuel",
            payerType: "personal",
            paidByMemberId: owner.id,
          }),
          actorId: owner.id,
          canApprove: true,
          source: "manual",
          now,
        });
        expect(created.reimbursementStatus).toBe("approved");

        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "voided",
            voidedAt: now,
            voidedBy: owner.id,
            voidReason: "Attempted direct reimbursement void",
            version: created.version + 1,
            updatedAt: now,
          })
          .where(eq(expenses.id, created.expenseId));
      }),
      "active reimbursements require the linked correction workflow",
    );
  });

  it("rejects a posted expense whose review is still pending", async () => {
    await expectDatabaseFailure(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [member] = await tx
          .insert(teamMembers)
          .values({ name: "Pending review guard member", active: true })
          .returning({ id: teamMembers.id });
        if (!member) throw new Error("pending_guard_member_missing");
        await tx.insert(expenses).values({
          amount: 2_000,
          currency: "USD",
          category: "Fuel",
          source: "manual",
          submittedBy: member.id,
          payerType: "company",
          reviewStatus: "pending",
          reviewedBy: null,
          reviewedAt: null,
          lifecycleStatus: "posted",
          postedAt: now,
          postedBy: member.id,
          paidAt: now,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }),
      "expenses_review_lifecycle_check",
    );
  });

  it("resolves the retained Dump label without guessing unknown categories", async () => {
    try {
      await getDb().transaction(async (tx) => {
        await expect(
          resolveExpenseCategoryAlias(tx, " Dump "),
        ).resolves.toEqual({
          category: "Dump Fees",
          categoryId: "dump_fees",
          categoryNeedsReview: false,
        });
        await expect(
          resolveExpenseCategoryAlias(tx, "Special historical cost"),
        ).resolves.toEqual({
          category: "Special historical cost",
          categoryId: null,
          categoryNeedsReview: true,
        });
        throw ROLLBACK;
      });
    } catch (error) {
      if (error === ROLLBACK) return;
      throw new Error(databaseErrorText(error));
    }
    throw new Error("Expected the verification transaction to roll back.");
  });
});
