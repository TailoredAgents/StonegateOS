import {
  canUseExpenseReceiptCapture,
  isExpenseAdSpendEnabled,
  isExpenseOverviewEnabled,
  isExpenseReceiptCaptureApiEnabled,
  isExpenseReceiptCrewEnabled,
  isExpenseReceiptCaptureEnabled,
  isExpenseReceiptWorkerEnabled,
  isExpenseReimbursementEnabled,
} from "@/lib/expense-feature-flags";

describe("expense rollout flags", () => {
  const keys = [
    "EXPENSE_RECEIPT_CAPTURE_ENABLED",
    "EXPENSE_RECEIPT_WORKER_ENABLED",
    "EXPENSE_RECEIPT_CREW_ENABLED",
    "EXPENSE_AD_SPEND_ENABLED",
    "EXPENSE_REIMBURSEMENT_ENABLED",
    "EXPENSE_OVERVIEW_ENABLED",
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

  it("keeps ad spend, reimbursements, and Overview independently gated", () => {
    process.env["EXPENSE_AD_SPEND_ENABLED"] = "1";
    process.env["EXPENSE_REIMBURSEMENT_ENABLED"] = "0";
    process.env["EXPENSE_OVERVIEW_ENABLED"] = "1";

    expect(isExpenseAdSpendEnabled()).toBe(true);
    expect(isExpenseReimbursementEnabled()).toBe(false);
    expect(isExpenseOverviewEnabled()).toBe(true);
  });
});
