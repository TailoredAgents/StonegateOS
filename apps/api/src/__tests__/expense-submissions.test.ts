import {
  EXPENSE_BUSINESS_TIME_ZONE,
  ExpenseReviewDecisionSchema,
  expenseBusinessDateToTimestamp,
  parseExpenseSubmission,
} from "@/lib/expense-submissions";
import { TeamMutationFailure } from "@/lib/team-mutation";

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: 12_345,
    purchaseDate: "2026-08-20",
    categoryId: "fuel",
    payerType: "company",
    paidByMemberId: null,
    ...overrides,
  };
}

function expectInvalid(input: unknown): TeamMutationFailure {
  try {
    parseExpenseSubmission(input);
    throw new Error("expected expense submission validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    return error as TeamMutationFailure;
  }
}

describe("expense submissions", () => {
  it("defaults an unsplit expense to one exact allocation", () => {
    const result = parseExpenseSubmission(validSubmission());

    expect(result.allocations).toEqual([
      { categoryId: "fuel", amountCents: 12_345 },
    ]);
  });

  it("accepts an exact optional split containing the primary category", () => {
    const result = parseExpenseSubmission(
      validSubmission({
        allocations: [
          { categoryId: "fuel", amountCents: 8_000 },
          { categoryId: "supplies", amountCents: 4_345 },
        ],
      }),
    );

    expect(result.allocations).toHaveLength(2);
    expect(
      result.allocations?.reduce(
        (total, allocation) => total + allocation.amountCents,
        0,
      ),
    ).toBe(12_345);
  });

  it.each([
    [
      "allocation mismatch",
      {
        allocations: [{ categoryId: "fuel", amountCents: 12_344 }],
      },
    ],
    [
      "duplicate allocation",
      {
        allocations: [
          { categoryId: "fuel", amountCents: 10_000 },
          { categoryId: "fuel", amountCents: 2_345 },
        ],
      },
    ],
    [
      "missing primary allocation",
      {
        allocations: [{ categoryId: "supplies", amountCents: 12_345 }],
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    const error = expectInvalid(validSubmission(overrides));
    expect(error.code).toBe("invalid");
  });

  it("requires a personal payer and prevents one on company purchases", () => {
    expectInvalid(
      validSubmission({ payerType: "personal", paidByMemberId: null }),
    );
    expectInvalid(
      validSubmission({
        payerType: "company",
        paidByMemberId: "11111111-1111-4111-8111-111111111111",
      }),
    );

    expect(
      parseExpenseSubmission(
        validSubmission({
          payerType: "personal",
          paidByMemberId: "11111111-1111-4111-8111-111111111111",
        }),
      ).payerType,
    ).toBe("personal");
  });

  it.each(["2026-02-30", "1999-12-31", "2999-01-01", "08/20/2026"])(
    "rejects unsupported purchase date %s",
    (purchaseDate) => {
      expectInvalid(validSubmission({ purchaseDate }));
    },
  );

  it("stores business dates at Eastern noon across DST", () => {
    expect(EXPENSE_BUSINESS_TIME_ZONE).toBe("America/New_York");
    expect(expenseBusinessDateToTimestamp("2026-01-15").toISOString()).toBe(
      "2026-01-15T17:00:00.000Z",
    );
    expect(expenseBusinessDateToTimestamp("2026-07-15").toISOString()).toBe(
      "2026-07-15T16:00:00.000Z",
    );
  });

  it("requires a useful rejection reason and allows a clean approval", () => {
    expect(
      ExpenseReviewDecisionSchema.safeParse({
        decision: "approve",
        reason: null,
      }).success,
    ).toBe(true);
    expect(
      ExpenseReviewDecisionSchema.safeParse({
        decision: "reject",
        reason: "no",
      }).success,
    ).toBe(false);
    expect(
      ExpenseReviewDecisionSchema.parse({
        decision: "reject",
        reason: "Wrong total",
      }).reason,
    ).toBe("Wrong total");
  });
});
