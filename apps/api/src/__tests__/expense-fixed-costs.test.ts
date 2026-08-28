import {
  expenseFixedCostDailyCents,
  parseExpenseFixedCostCreateInput,
  parseExpenseFixedCostRevisionInput,
  validateExpenseFixedCostAsOf,
} from "@/lib/expense-fixed-costs";
import { TeamMutationFailure } from "@/lib/team-mutation";

const NOW = new Date("2026-08-27T14:00:00.000Z");

function expectInvalid(
  operation: () => unknown,
  field: string,
): TeamMutationFailure {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    const failure = error as TeamMutationFailure;
    expect(failure.code).toBe("invalid");
    expect(failure.status).toBe(422);
    expect(failure.fieldErrors).toHaveProperty(field);
    return failure;
  }
  throw new Error("Expected fixed-cost input validation to fail.");
}

describe("fixed monthly cost input", () => {
  it("normalizes a strict create payload without changing exact cents", () => {
    expect(
      parseExpenseFixedCostCreateInput(
        {
          name: "  Office\u00a0Rent  ",
          monthlyAmountCents: 275_099,
          categoryId: "office_admin",
          effectiveStartDate: "2026-08-01",
        },
        NOW,
      ),
    ).toEqual({
      name: "Office Rent",
      monthlyAmountCents: 275_099,
      categoryId: "office_admin",
      effectiveStartDate: "2026-08-01",
    });
  });

  it.each([
    ["zero amount", { monthlyAmountCents: 0 }, "monthlyAmountCents"],
    ["fractional cents", { monthlyAmountCents: 1_000.5 }, "monthlyAmountCents"],
    ["blank name", { name: "   " }, "name"],
    ["unstable category ID", { categoryId: "Office/Admin" }, "categoryId"],
    [
      "impossible date",
      { effectiveStartDate: "2026-02-30" },
      "effectiveStartDate",
    ],
    ["future date", { effectiveStartDate: "2026-08-28" }, "effectiveStartDate"],
  ] as const)("rejects %s", (_label, override, field) => {
    expectInvalid(
      () =>
        parseExpenseFixedCostCreateInput(
          {
            name: "Office rent",
            monthlyAmountCents: 275_000,
            categoryId: "office_admin",
            effectiveStartDate: "2026-08-01",
            ...override,
          },
          NOW,
        ),
      field,
    );
  });

  it("rejects unknown fields instead of silently accepting financial input", () => {
    expectInvalid(
      () =>
        parseExpenseFixedCostCreateInput(
          {
            name: "Office rent",
            monthlyAmountCents: 275_000,
            categoryId: "office_admin",
            effectiveStartDate: "2026-08-01",
            currency: "CAD",
          },
          NOW,
        ),
      "request",
    );
  });

  it("validates revise and end payloads with optimistic versions", () => {
    expect(
      parseExpenseFixedCostRevisionInput(
        {
          action: "revise",
          expectedVersion: 3,
          name: "Insurance",
          monthlyAmountCents: 45_500,
          categoryId: "insurance",
          effectiveStartDate: "2026-08-15",
        },
        NOW,
      ),
    ).toEqual({
      action: "revise",
      expectedVersion: 3,
      name: "Insurance",
      monthlyAmountCents: 45_500,
      categoryId: "insurance",
      effectiveStartDate: "2026-08-15",
    });
    expect(
      parseExpenseFixedCostRevisionInput(
        {
          action: "end",
          expectedVersion: 4,
          effectiveStartDate: "2026-08-27",
        },
        NOW,
      ),
    ).toEqual({
      action: "end",
      expectedVersion: 4,
      effectiveStartDate: "2026-08-27",
    });

    expectInvalid(
      () =>
        parseExpenseFixedCostRevisionInput(
          {
            action: "end",
            expectedVersion: 0,
            effectiveStartDate: "2026-08-27",
          },
          NOW,
        ),
      "expectedVersion",
    );
  });

  it("accepts only real date-only as-of values", () => {
    expect(validateExpenseFixedCostAsOf("2024-02-29")).toBe("2024-02-29");
    expectInvalid(
      () => validateExpenseFixedCostAsOf("2026-08-27T00:00:00-04:00"),
      "asOf",
    );
    expectInvalid(() => validateExpenseFixedCostAsOf("2025-02-29"), "asOf");
  });
});

describe("fixed monthly cost daily proration", () => {
  it.each([
    ["2026-02", 28],
    ["2024-02", 29],
    ["2026-04", 30],
    ["2026-01", 31],
  ] as const)(
    "reconciles every cent across %s with %i days",
    (month, daysInMonth) => {
      const monthlyAmountCents = 123_457;
      const daily = Array.from({ length: daysInMonth }, (_, index) =>
        expenseFixedCostDailyCents(
          monthlyAmountCents,
          `${month}-${String(index + 1).padStart(2, "0")}`,
        ),
      );

      expect(daily.reduce((total, amount) => total + amount, 0)).toBe(
        monthlyAmountCents,
      );
      expect(Math.max(...daily) - Math.min(...daily)).toBeLessThanOrEqual(1);
      expect(daily.every((amount) => Number.isSafeInteger(amount))).toBe(true);
    },
  );

  it("uses cumulative-floor allocation for deterministic remainder cents", () => {
    expect(
      Array.from({ length: 3 }, (_, index) =>
        expenseFixedCostDailyCents(
          100,
          `2026-02-${String(index + 1).padStart(2, "0")}`,
        ),
      ),
    ).toEqual([3, 4, 3]);
    expect(expenseFixedCostDailyCents(100, "2026-02-28")).toBe(4);
  });

  it("rejects invalid amounts and dates before performing arithmetic", () => {
    expect(() => expenseFixedCostDailyCents(0, "2026-08-01")).toThrow(
      "supported positive cents",
    );
    expect(() =>
      expenseFixedCostDailyCents(Number.MAX_SAFE_INTEGER, "2026-08-01"),
    ).toThrow("supported positive cents");
    expect(() => expenseFixedCostDailyCents(100, "2026-02-30")).toThrow(
      TeamMutationFailure,
    );
  });
});
