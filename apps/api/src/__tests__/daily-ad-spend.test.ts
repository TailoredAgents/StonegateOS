import { dailyAdSpend, expenseAllocations, expenses } from "@/db";
import {
  dailyAdPurchaseTimestamp,
  dailyAdSpendDayFromRows,
  parseDailyAdSpendSaveInput,
  planDailyAdSpendChange,
  saveDailyAdSpendDay,
  type DailyAdSpendSaveInput,
} from "@/lib/daily-ad-spend";
import { TeamMutationFailure } from "@/lib/team-mutation";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const FACEBOOK_EXPENSE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-27T14:00:00.000Z");

type RegistryRow = typeof dailyAdSpend.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;
type AllocationRow = typeof expenseAllocations.$inferSelect;

function registryRow(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    platform: "facebook",
    businessDate: "2026-08-26",
    amountCents: 12_500,
    currentExpenseId: FACEBOOK_EXPENSE_ID,
    enteredBy: ACTOR_ID,
    confirmedAt: new Date("2026-08-27T12:00:00.000Z"),
    version: 1,
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
    updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    ...overrides,
  };
}

function expenseRow(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: FACEBOOK_EXPENSE_ID,
    amount: 12_500,
    currency: "USD",
    category: "Advertising",
    categoryId: "advertising",
    categoryNeedsReview: false,
    vendor: "Meta Ads",
    memo: "Facebook ad spend for 2026-08-26",
    method: null,
    source: "daily_ad_spend",
    submittedBy: ACTOR_ID,
    payerType: "company",
    paidByMemberId: null,
    reviewStatus: "approved",
    reviewedBy: ACTOR_ID,
    reviewedAt: new Date("2026-08-27T12:00:00.000Z"),
    reviewReason: null,
    receiptCaptureId: null,
    appointmentId: null,
    paidAt: new Date("2026-08-26T16:00:00.000Z"),
    coverageStartAt: null,
    coverageEndAt: null,
    receiptFilename: null,
    receiptUrl: null,
    receiptContentType: null,
    bankTransactionId: null,
    payoutRunId: null,
    lifecycleStatus: "posted",
    version: 2,
    postedAt: new Date("2026-08-27T12:00:00.000Z"),
    postedBy: ACTOR_ID,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    correctedAt: null,
    correctedBy: null,
    correctionReason: null,
    reversalOfExpenseId: null,
    correctionOfExpenseId: null,
    correctedByExpenseId: null,
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
    updatedAt: new Date("2026-08-27T12:00:00.000Z"),
    ...overrides,
  };
}

type FakeState = {
  registry: RegistryRow[];
  ledger: ExpenseRow[];
  allocations: AllocationRow[];
  sequence: string[];
  nextId: number;
};

function generatedId(state: FakeState): string {
  state.nextId += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(state.nextId).padStart(12, "0")}`;
}

function fakeTransaction(state: FakeState) {
  return {
    execute: jest.fn(() => {
      state.sequence.push("date_lock");
      return Promise.resolve([]);
    }),
    select: jest.fn(() => ({
      from: jest.fn((table: unknown) => ({
        where: jest.fn(() => {
          if (table === dailyAdSpend) {
            return {
              for: jest.fn(() =>
                Promise.resolve(state.registry.map((row) => ({ ...row }))),
              ),
            };
          }
          if (table !== expenses) throw new Error("unexpected_select_table");
          return {
            for: jest.fn(() => ({
              limit: jest.fn(() => {
                const current = state.ledger.find(
                  (row) =>
                    row.lifecycleStatus === "posted" &&
                    row.reversalOfExpenseId === null &&
                    row.correctedByExpenseId === null,
                );
                return Promise.resolve(current ? [{ ...current }] : []);
              }),
            })),
          };
        }),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        if (table === expenseAllocations) {
          state.sequence.push("allocation");
          state.allocations.push({
            id: generatedId(state),
            expenseId: String(values["expenseId"]),
            categoryId: String(values["categoryId"]),
            amountCents: Number(values["amountCents"]),
            createdAt: values["createdAt"] as Date,
          });
          return Promise.resolve();
        }
        if (table === expenses) {
          const id = generatedId(state);
          const row = expenseRow({
            ...(values as Partial<ExpenseRow>),
            id,
          });
          state.sequence.push("expense_draft");
          state.ledger.push(row);
          return {
            returning: jest.fn(() => Promise.resolve([{ id }])),
          };
        }
        if (table === dailyAdSpend) {
          const row = registryRow({
            ...(values as Partial<RegistryRow>),
            id: generatedId(state),
          });
          state.sequence.push("registry_insert");
          state.registry.push(row);
          return {
            returning: jest.fn(() => Promise.resolve([{ ...row }])),
          };
        }
        throw new Error("unexpected_insert_table");
      }),
    })),
    update: jest.fn((table: unknown) => ({
      set: jest.fn((patch: Partial<ExpenseRow & RegistryRow>) => ({
        where: jest.fn(() => ({
          returning: jest.fn(() => {
            if (table === expenses) {
              if (patch.lifecycleStatus === "posted") {
                const draft = [...state.ledger]
                  .reverse()
                  .find((row) => row.lifecycleStatus === "draft");
                if (!draft) return Promise.resolve([]);
                Object.assign(draft, patch);
                state.sequence.push("expense_posted");
                return Promise.resolve([
                  { id: draft.id, version: draft.version },
                ]);
              }
              const current = state.ledger.find(
                (row) => row.id === FACEBOOK_EXPENSE_ID,
              );
              if (!current) return Promise.resolve([]);
              Object.assign(current, patch);
              state.sequence.push(`expense_${String(patch.lifecycleStatus)}`);
              return Promise.resolve([{ id: current.id }]);
            }
            if (table === dailyAdSpend) {
              const current = state.registry.find(
                (row) => row.platform === "facebook",
              );
              if (!current) return Promise.resolve([]);
              Object.assign(current, patch);
              state.sequence.push("registry_update");
              return Promise.resolve([{ ...current }]);
            }
            throw new Error("unexpected_update_table");
          }),
        })),
      })),
    })),
  };
}

function stateWithFacebook(): FakeState {
  return {
    registry: [registryRow()],
    ledger: [expenseRow()],
    allocations: [],
    sequence: [],
    nextId: 0,
  };
}

function input(
  facebook: DailyAdSpendSaveInput["facebook"],
  google: DailyAdSpendSaveInput["google"] = null,
): DailyAdSpendSaveInput {
  return { businessDate: "2026-08-26", facebook, google };
}

function expectFailure(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected_failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    expect((error as TeamMutationFailure).code).toBe(code);
  }
}

describe("daily advertising input and accounting date", () => {
  it("keeps missing distinct from an explicitly confirmed zero", () => {
    const day = dailyAdSpendDayFromRows("2026-08-26", [
      registryRow({ amountCents: 0, currentExpenseId: null }),
    ]);
    expect(day.facebook).toMatchObject({ amountCents: 0, expenseId: null });
    expect(day.google).toBeNull();
  });

  it("accepts one or both platform values but rejects ambiguous payloads", () => {
    expect(
      parseDailyAdSpendSaveInput(input({ amountCents: 0, version: null }), NOW),
    ).toMatchObject({ facebook: { amountCents: 0 }, google: null });
    expectFailure(
      () =>
        parseDailyAdSpendSaveInput(
          { businessDate: "2026-08-26", facebook: null, google: null },
          NOW,
        ),
      "invalid",
    );
    expectFailure(
      () =>
        parseDailyAdSpendSaveInput(
          {
            ...input({ amountCents: 100, version: null }),
            providerSpendCents: 9_999,
          },
          NOW,
        ),
      "invalid",
    );
  });

  it("rejects future, impossible, fractional, negative, and excessive values", () => {
    for (const candidate of [
      input({ amountCents: -1, version: null }),
      input({ amountCents: 1.5, version: null }),
      input({ amountCents: 100_000_001, version: null }),
      {
        ...input({ amountCents: 10, version: null }),
        businessDate: "2026-02-30",
      },
      {
        ...input({ amountCents: 10, version: null }),
        businessDate: "2026-08-28",
      },
    ]) {
      expectFailure(
        () => parseDailyAdSpendSaveInput(candidate, NOW),
        "invalid",
      );
    }
  });

  it("maps both DST transition dates to unambiguous Eastern noon", () => {
    expect(dailyAdPurchaseTimestamp("2026-03-08").toISOString()).toBe(
      "2026-03-08T16:00:00.000Z",
    );
    expect(dailyAdPurchaseTimestamp("2026-11-01").toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
  });
});

describe("daily advertising change planning", () => {
  const current = registryRow();

  it.each([
    [null, null, "missing"],
    [null, { amountCents: 0, version: null }, "confirmed_zero"],
    [null, { amountCents: 100, version: null }, "posted"],
    [current, { amountCents: 12_500, version: 1 }, "noop"],
    [current, { amountCents: 11_000, version: 1 }, "corrected"],
    [current, { amountCents: 0, version: 1 }, "reversed_to_zero"],
    [
      registryRow({ amountCents: 0, currentExpenseId: null }),
      { amountCents: 8_000, version: 1 },
      "posted",
    ],
  ] as const)("plans %# safely", (existing, requested, expected) => {
    expect(planDailyAdSpendChange("facebook", existing, requested)).toBe(
      expected,
    );
  });

  it("fails closed on stale versions and attempts to erase confirmation", () => {
    expectFailure(
      () =>
        planDailyAdSpendChange("facebook", current, {
          amountCents: 11_000,
          version: 9,
        }),
      "conflict",
    );
    expectFailure(
      () => planDailyAdSpendChange("facebook", current, null),
      "invalid",
    );
  });
});

describe("daily advertising ledger service", () => {
  it("posts a new positive expense through draft, allocation, and posted", async () => {
    const state: FakeState = {
      registry: [],
      ledger: [],
      allocations: [],
      sequence: [],
      nextId: 0,
    };
    const result = await saveDailyAdSpendDay(fakeTransaction(state) as never, {
      ...input(
        { amountCents: 9_000, version: null },
        { amountCents: 0, version: null },
      ),
      actorId: ACTOR_ID,
      now: NOW,
    });

    expect(result.facebook).toMatchObject({ amountCents: 9_000, version: 1 });
    expect(result.google).toMatchObject({ amountCents: 0, expenseId: null });
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      amount: 9_000,
      vendor: "Meta Ads",
      source: "daily_ad_spend",
      categoryId: "advertising",
      reviewStatus: "approved",
      lifecycleStatus: "posted",
      version: 2,
    });
    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0]).toMatchObject({
      amountCents: 9_000,
      categoryId: "advertising",
    });
    expect(state.sequence).toEqual([
      "date_lock",
      "expense_draft",
      "allocation",
      "expense_posted",
      "registry_insert",
      "registry_insert",
    ]);
  });

  it("corrects a positive amount with linked reversal and replacement", async () => {
    const state = stateWithFacebook();
    const result = await saveDailyAdSpendDay(fakeTransaction(state) as never, {
      ...input({ amountCents: 14_000, version: 1 }),
      actorId: ACTOR_ID,
      now: NOW,
    });

    const original = state.ledger.find((row) => row.id === FACEBOOK_EXPENSE_ID);
    const reversal = state.ledger.find(
      (row) => row.reversalOfExpenseId === FACEBOOK_EXPENSE_ID,
    );
    const replacement = state.ledger.find(
      (row) => row.correctionOfExpenseId === FACEBOOK_EXPENSE_ID,
    );
    expect(original).toMatchObject({
      lifecycleStatus: "corrected",
      correctedByExpenseId: replacement?.id,
      version: 3,
    });
    expect(reversal).toMatchObject({
      amount: -12_500,
      lifecycleStatus: "posted",
      source: "manual_correction",
    });
    expect(replacement).toMatchObject({
      amount: 14_000,
      lifecycleStatus: "posted",
      source: "manual_correction",
    });
    expect(state.allocations.map((row) => row.amountCents)).toEqual([
      -12_500, 14_000,
    ]);
    expect(result.facebook).toMatchObject({
      amountCents: 14_000,
      expenseId: replacement?.id,
      version: 2,
    });
    expect(result.changes[0]).toMatchObject({
      kind: "corrected",
      reversalExpenseId: reversal?.id,
      expenseId: replacement?.id,
    });
  });

  it("reverses a saved value to zero without creating a replacement expense", async () => {
    const state = stateWithFacebook();
    const result = await saveDailyAdSpendDay(fakeTransaction(state) as never, {
      ...input({ amountCents: 0, version: 1 }),
      actorId: ACTOR_ID,
      now: NOW,
    });

    const original = state.ledger.find((row) => row.id === FACEBOOK_EXPENSE_ID);
    const reversal = state.ledger.find(
      (row) => row.reversalOfExpenseId === FACEBOOK_EXPENSE_ID,
    );
    expect(original).toMatchObject({ lifecycleStatus: "voided", version: 3 });
    expect(reversal).toMatchObject({ amount: -12_500 });
    expect(state.ledger).toHaveLength(2);
    expect(result.facebook).toMatchObject({
      amountCents: 0,
      expenseId: null,
      version: 2,
    });
    expect(result.changes[0]).toMatchObject({
      kind: "reversed_to_zero",
      expenseId: null,
      reversalExpenseId: reversal?.id,
    });
  });

  it("checks both versions before writing either platform", async () => {
    const state = stateWithFacebook();
    await expect(
      saveDailyAdSpendDay(fakeTransaction(state) as never, {
        ...input(
          { amountCents: 14_000, version: 9 },
          { amountCents: 3_000, version: null },
        ),
        actorId: ACTOR_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(state.ledger).toHaveLength(1);
    expect(state.registry).toHaveLength(1);
    expect(state.sequence).toEqual(["date_lock"]);
  });
});
