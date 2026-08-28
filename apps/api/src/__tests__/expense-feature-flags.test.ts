import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canUseExpenseReceiptCapture,
  isExpenseAdSpendEnabled,
  isExpenseDumpTicketsEnabled,
  isExpenseFixedCostsEnabled,
  isExpenseOverviewEnabled,
  isExpenseReceiptCaptureApiEnabled,
  isExpenseReceiptCrewEnabled,
  isExpenseReceiptCaptureEnabled,
  isExpenseReceiptWorkerEnabled,
  isExpenseReimbursementEnabled,
} from "@/lib/expense-feature-flags";

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("expense rollout flags", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const keys = [
    "EXPENSE_RECEIPT_CAPTURE_ENABLED",
    "EXPENSE_RECEIPT_WORKER_ENABLED",
    "EXPENSE_RECEIPT_CREW_ENABLED",
    "EXPENSE_AD_SPEND_ENABLED",
    "EXPENSE_REIMBURSEMENT_ENABLED",
    "EXPENSE_OVERVIEW_ENABLED",
    "EXPENSE_DUMP_TICKETS_ENABLED",
    "EXPENSE_FIXED_COSTS_ENABLED",
  ] as const;
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );

  it("supports an owner-only receipt pilot before crew rollout", () => {
    process.env["EXPENSE_RECEIPT_CAPTURE_ENABLED"] = "1";
    process.env["EXPENSE_RECEIPT_WORKER_ENABLED"] = "1";
    process.env["EXPENSE_RECEIPT_CREW_ENABLED"] = "0";

    expect(isExpenseReceiptCrewEnabled()).toBe(false);
    expect(canUseExpenseReceiptCapture(true)).toBe(true);
    expect(canUseExpenseReceiptCapture(false)).toBe(false);

    process.env["EXPENSE_RECEIPT_CREW_ENABLED"] = "1";
    expect(isExpenseReceiptCrewEnabled()).toBe(true);
    expect(canUseExpenseReceiptCapture(false)).toBe(true);

    process.env["EXPENSE_RECEIPT_CAPTURE_ENABLED"] = "0";
    expect(canUseExpenseReceiptCapture(true)).toBe(false);
    expect(canUseExpenseReceiptCapture(false)).toBe(false);
  });

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: originalNodeEnv,
      writable: true,
    });
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ["1", "0", false],
    ["0", "1", false],
    ["1", "1", true],
    ["0", "0", false],
  ])(
    "requires API=%s and worker=%s before exposing receipt capture",
    (api, worker, expected) => {
      process.env["EXPENSE_RECEIPT_CAPTURE_ENABLED"] = api;
      process.env["EXPENSE_RECEIPT_WORKER_ENABLED"] = worker;

      expect(isExpenseReceiptCaptureApiEnabled()).toBe(api === "1");
      expect(isExpenseReceiptWorkerEnabled()).toBe(worker === "1");
      expect(isExpenseReceiptCaptureEnabled()).toBe(expected);
    },
  );

  it("keeps ad spend, reimbursements, Overview, dump tickets, and fixed costs independently gated", () => {
    process.env["EXPENSE_AD_SPEND_ENABLED"] = "1";
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = "0";
    process.env["EXPENSE_OVERVIEW_ENABLED"] = "1";
    process.env["EXPENSE_DUMP_TICKETS_ENABLED"] = "0";
    process.env["EXPENSE_FIXED_COSTS_ENABLED"] = "0";

    expect(isExpenseAdSpendEnabled()).toBe(true);
    expect(isExpenseReimbursementEnabled()).toBe(false);
    expect(isExpenseOverviewEnabled()).toBe(true);
    expect(isExpenseDumpTicketsEnabled()).toBe(false);
    expect(isExpenseFixedCostsEnabled()).toBe(false);

    process.env["EXPENSE_FIXED_COSTS_ENABLED"] = "1";
    process.env["EXPENSE_DUMP_TICKETS_ENABLED"] = "1";
    expect(isExpenseFixedCostsEnabled()).toBe(true);
    expect(isExpenseDumpTicketsEnabled()).toBe(true);
  });

  it("keeps fixed-cost setup default-off in production and honors an explicit enable", () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "production",
      writable: true,
    });
    delete process.env["EXPENSE_FIXED_COSTS_ENABLED"];
    delete process.env["EXPENSE_DUMP_TICKETS_ENABLED"];
    expect(isExpenseFixedCostsEnabled()).toBe(false);
    expect(isExpenseDumpTicketsEnabled()).toBe(false);

    process.env["EXPENSE_FIXED_COSTS_ENABLED"] = "true";
    process.env["EXPENSE_DUMP_TICKETS_ENABLED"] = "true";
    expect(isExpenseFixedCostsEnabled()).toBe(true);
    expect(isExpenseDumpTicketsEnabled()).toBe(true);
  });

  it("publishes one dump-ticket capability and gates every new mutation surface", () => {
    const capabilities = source("app/api/admin/expenses/capabilities/route.ts");
    const confirmation = source(
      "app/api/admin/expenses/captures/[captureId]/confirm/route.ts",
    );
    const submissions = source("app/api/admin/expenses/submissions/route.ts");
    const review = source(
      "app/api/admin/expenses/submissions/[expenseId]/review/route.ts",
    );
    const correction = source(
      "app/api/admin/expenses/[expenseId]/correct/route.ts",
    );

    expect(capabilities).toContain(
      "dumpTickets: isExpenseDumpTicketsEnabled()",
    );
    for (const route of [confirmation, submissions, review, correction]) {
      expect(route).toContain("isExpenseDumpTicketsEnabled");
    }
    expect(confirmation).toContain("dumpTicketsEnabled,");
    expect(review).toContain(
      "dumpTicketsEnabled: isExpenseDumpTicketsEnabled()",
    );
  });
});
