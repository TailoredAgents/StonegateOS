import { assertGenericExpenseMutationAllowed } from "@/lib/expense-managed-mutation";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

function fakeTransaction(resultSets: unknown[][]): TeamMutationTransaction {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(resultSets[index++] ?? []),
        }),
      }),
    }),
  } as unknown as TeamMutationTransaction;
}

const legacyExpense = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "manual",
  categoryId: null,
  submittedBy: null,
  receiptCaptureId: null,
  payerType: "company" as const,
  reviewStatus: "approved" as const,
};

async function expectConflict(
  operation: Promise<void>,
  messageFragment?: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected managed mutation to be rejected");
  } catch (error) {
    expect(error).toMatchObject({ code: "conflict" });
    if (messageFragment) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(messageFragment);
    }
  }
}

describe("generic expense mutation workflow guards", () => {
  it("blocks the legacy post route from bypassing pending review", async () => {
    await expectConflict(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([]),
        { ...legacyExpense, reviewStatus: "pending" },
        "post",
      ),
    );
  });

  it("allows classified corrections through the evidence-preserving lifecycle", async () => {
    await expect(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([[]]),
        { ...legacyExpense, categoryId: "fuel" },
        "correct",
      ),
    ).resolves.toBeUndefined();
  });

  it("still blocks direct edits that could mutate submitted evidence", async () => {
    await expectConflict(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([]),
        {
          ...legacyExpense,
          source: "receipt_scan",
          categoryId: "fuel",
        },
        "edit",
      ),
      "cannot be edited",
    );
  });

  it("lets an approver post an owner manual draft without opening the crew review bypass", async () => {
    await expect(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([]),
        { ...legacyExpense, reviewStatus: "draft" },
        "post",
      ),
    ).resolves.toBeUndefined();
    await expectConflict(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([]),
        {
          ...legacyExpense,
          reviewStatus: "pending",
          submittedBy: "22222222-2222-4222-8222-222222222222",
        },
        "post",
      ),
    );
  });

  it("allows an owner manual draft to retain stable category evidence while editing", async () => {
    await expect(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([]),
        {
          ...legacyExpense,
          reviewStatus: "draft",
          categoryId: "fuel",
          submittedBy: "22222222-2222-4222-8222-222222222222",
        },
        "edit",
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks mutation of the expense selected by the daily-ad registry", async () => {
    await expectConflict(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([
          [{ platform: "facebook", businessDate: "2026-08-26" }],
        ]),
        legacyExpense,
        "void",
      ),
      "Daily Ad Spend",
    );
  });

  it("keeps the legacy correction path available for unmanaged expenses", async () => {
    await expect(
      assertGenericExpenseMutationAllowed(
        fakeTransaction([[]]),
        legacyExpense,
        "correct",
      ),
    ).resolves.toBeUndefined();
  });
});
