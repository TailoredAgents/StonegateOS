import fs from "node:fs";
import path from "node:path";
import {
  assertExpenseActionAllowed,
  assertExpenseFinancialShape,
  detectExpenseReceiptContentType,
  MAX_EXPENSE_CENTS,
  validateExpenseWriteInput,
} from "@/lib/expense-lifecycle";
import { TeamMutationFailure } from "@/lib/team-mutation";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function validExpense(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: 12_345,
    currency: "USD",
    category: "Equipment",
    vendor: "Local supplier",
    memo: "Replacement blade",
    method: "card",
    paidAt: "2026-08-07T12:00:00.000Z",
    coverageStartAt: "2026-08-01T12:00:00.000Z",
    coverageEndAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

function lifecycleRecord(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleStatus: "draft" as const,
    source: "manual",
    bankTransactionId: null,
    payoutRunId: null,
    reversalOfExpenseId: null,
    ...overrides,
  } as Parameters<typeof assertExpenseActionAllowed>[0];
}

function expectMutationFailure(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected_failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    expect((error as TeamMutationFailure).code).toBe(code);
  }
}

describe("expense integrity", () => {
  it("accepts a bounded USD expense and normalizes dates", () => {
    const parsed = validateExpenseWriteInput(
      validExpense(),
      new Date("2026-08-08T12:00:00.000Z"),
    );

    expect(parsed.amountCents).toBe(12_345);
    expect(parsed.currency).toBe("USD");
    expect(parsed.paidAt.toISOString()).toBe("2026-08-07T12:00:00.000Z");
    expect(parsed.coverageEndAt?.toISOString()).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });

  it.each([
    ["zero amount", { amountCents: 0 }],
    ["negative amount", { amountCents: -1 }],
    ["excessive amount", { amountCents: MAX_EXPENSE_CENTS + 1 }],
    ["fractional cents", { amountCents: 1.5 }],
    ["non-USD currency", { currency: "EUR" }],
    ["missing category", { category: "" }],
    ["unknown method", { method: "crypto" }],
    ["client-controlled source", { source: "payout_run" }],
    ["unexpected mutation field", { reason: "not valid on a draft" }],
  ])("rejects %s", (_label, override) => {
    expectMutationFailure(
      () =>
        validateExpenseWriteInput(
          validExpense(override),
          new Date("2026-08-08T12:00:00.000Z"),
        ),
      "invalid",
    );
  });

  it("rejects impossible, future, and reversed date ranges", () => {
    expectMutationFailure(
      () =>
        validateExpenseWriteInput(
          validExpense({ paidAt: "2026-08-12T12:00:00.000Z" }),
          new Date("2026-08-08T12:00:00.000Z"),
        ),
      "invalid",
    );
    expectMutationFailure(
      () =>
        validateExpenseWriteInput(
          validExpense({
            coverageStartAt: "2026-09-01T12:00:00.000Z",
            coverageEndAt: "2026-08-01T12:00:00.000Z",
          }),
          new Date("2026-08-08T12:00:00.000Z"),
        ),
      "invalid",
    );
    expectMutationFailure(
      () =>
        validateExpenseWriteInput(
          validExpense({ paidAt: "2026-02-31T12:00:00.000Z" }),
          new Date("2026-08-08T12:00:00.000Z"),
        ),
      "invalid",
    );
  });

  it("detects receipt content from bytes rather than trusting the filename", () => {
    expect(
      detectExpenseReceiptContentType(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
      ),
    ).toBe("image/jpeg");
    expect(
      detectExpenseReceiptContentType(
        Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      ),
    ).toBe("application/pdf");
    expect(
      detectExpenseReceiptContentType(Uint8Array.from([0x4d, 0x5a, 0x90])),
    ).toBeNull();
  });

  it("permits edits only in Draft and corrections only in Posted", () => {
    expect(() =>
      assertExpenseActionAllowed(lifecycleRecord(), "edit"),
    ).not.toThrow();
    expect(() =>
      assertExpenseActionAllowed(lifecycleRecord(), "post"),
    ).not.toThrow();
    expect(() =>
      assertExpenseActionAllowed(
        lifecycleRecord({ lifecycleStatus: "posted" }),
        "correct",
      ),
    ).not.toThrow();
    expectMutationFailure(
      () =>
        assertExpenseActionAllowed(
          lifecycleRecord({ lifecycleStatus: "posted" }),
          "edit",
        ),
      "conflict",
    );
    expectMutationFailure(
      () =>
        assertExpenseActionAllowed(
          lifecycleRecord({ lifecycleStatus: "corrected" }),
          "correct",
        ),
      "conflict",
    );
  });

  it.each([
    ["payout", { payoutRunId: "11111111-1111-4111-8111-111111111111" }],
    ["bank", { bankTransactionId: "22222222-2222-4222-8222-222222222222" }],
    ["provider", { source: "payout_reimbursement" }],
    ["reversal", { source: "manual_correction", reversalOfExpenseId: "x" }],
  ])("fails closed for %s-owned records", (_label, override) => {
    expectMutationFailure(
      () =>
        assertExpenseActionAllowed(
          lifecycleRecord({ lifecycleStatus: "posted", ...override }),
          "void",
        ),
      "conflict",
    );
  });

  it("fails closed for malformed historical financial rows", () => {
    expectMutationFailure(
      () =>
        assertExpenseFinancialShape({
          amount: 10_000,
          currency: "USD",
          coverageStartAt: new Date("2026-09-01T12:00:00.000Z"),
          coverageEndAt: new Date("2026-08-01T12:00:00.000Z"),
        }),
      "conflict",
    );
    expectMutationFailure(
      () =>
        assertExpenseFinancialShape({
          amount: 0,
          currency: "USD",
          coverageStartAt: null,
          coverageEndAt: null,
        }),
      "conflict",
    );
  });

  it("registers migration 0072 immediately after 0071", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const prior = entries.findIndex(
      (entry) => entry.tag === "0071_audit_log_integrity",
    );

    expect(entries.slice(prior, prior + 2)).toEqual([
      expect.objectContaining({ idx: 68, tag: "0071_audit_log_integrity" }),
      expect.objectContaining({ idx: 69, tag: "0072_expense_integrity" }),
    ]);
  });

  it("defines an immutable correction ledger without deleting history", () => {
    const migration = source("src/db/migrations/0072_expense_integrity.sql");

    expect(migration).toContain("expense_lifecycle_status");
    expect(migration).toContain('"reversal_of_expense_id"');
    expect(migration).toContain('"correction_of_expense_id"');
    expect(migration).toContain("enforce_expense_lifecycle_transition");
    expect(migration).toContain(
      "posted expense financial evidence is immutable",
    );
    expect(migration).toContain(
      "manual expense ledger entries cannot be deleted",
    );
    expect(migration).toContain(
      "Immutable verified actor snapshot; intentionally not a mutable foreign key.",
    );
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"expenses"/iu);
  });

  it("keeps financial mutation, audit, and idempotency completion in one transaction", () => {
    const routePaths = [
      "app/api/admin/expenses/route.ts",
      "app/api/admin/expenses/[expenseId]/route.ts",
      "app/api/admin/expenses/[expenseId]/post/route.ts",
      "app/api/admin/expenses/[expenseId]/correct/route.ts",
      "app/api/admin/expenses/[expenseId]/void/route.ts",
    ];

    for (const routePath of routePaths) {
      const route = source(routePath);
      expect(route).toContain("beginTeamMutation(request");
      expect(route).toContain('requiredPermissions: ["expenses.approve"]');
      expect(route).toContain('risk: "financial"');
      expect(route).toContain("claimTeamMutationIdempotency");
      expect(route).toContain("db.transaction(async (tx)");
      expect(route).toContain("mutation.audit.insertSuccess(tx");
      expect(route).toContain("completeTeamMutationIdempotency(");
      expect(route).not.toContain("recordAuditEvent");
    }
  });

  it("uses expected versions and atomic reversal rows for terminal changes", () => {
    const postRoute = source(
      "app/api/admin/expenses/[expenseId]/post/route.ts",
    );
    const correctionRoute = source(
      "app/api/admin/expenses/[expenseId]/correct/route.ts",
    );
    const voidRoute = source(
      "app/api/admin/expenses/[expenseId]/void/route.ts",
    );

    for (const route of [postRoute, correctionRoute, voidRoute]) {
      expect(route).toContain("assertTeamMutationExpectedVersion");
      expect(route).toContain('.for("update")');
      expect(route).toContain("eq(expenses.version, existing.version)");
    }
    expect(correctionRoute).toContain("amount: -existing.amount");
    expect(correctionRoute).toContain("reversalOfExpenseId: expenseId");
    expect(correctionRoute).toContain("correctionOfExpenseId: expenseId");
    expect(correctionRoute).toContain("correctedByExpenseId: replacement.id");
    expect(voidRoute).toContain("amount: -existing.amount");
    expect(voidRoute).toContain("reversalOfExpenseId: expenseId");
  });

  it("excludes drafts from summaries and exposes accessible lifecycle actions", () => {
    const summary = source("app/api/admin/expenses/summary/route.ts");
    const ui = source("../site/src/app/team/components/ExpensesSection.tsx");
    const formUtils = source("../site/src/app/api/team/expenses/form-utils.ts");

    expect(summary).toContain('ne(expenses.lifecycleStatus, "draft")');
    expect(ui).toContain("Save draft");
    expect(ui).toContain("Post expense");
    expect(ui).toContain("Create correction");
    expect(ui).toContain("Void with reversal");
    expect(ui).toContain('aria-label="Expense views"');
    expect(ui).toContain('id="expense-add-title"');
    expect(ui).toContain('aria-labelledby="expense-add-title"');
    expect(formUtils).toContain("isTeamMutationSuccessEnvelope(parsedBody)");
    expect(formUtils).toContain(
      "parsedBody.receipt.actorId === expected.actorId",
    );
    expect(formUtils).toContain(
      "UUID_PATTERN.test(parsedBody.receipt.operationId)",
    );
    expect(formUtils).toContain(
      "UUID_PATTERN.test(parsedBody.receipt.auditEventId)",
    );
    expect(formUtils).toContain('secure: redirectTo.protocol === "https:"');
    expect(formUtils).toContain("returned an unreadable financial receipt");
    expect(formUtils).not.toContain("response.ok && body?.ok === true");
  });

  it("keeps receipt downloads private, authorized, and non-sniffable", () => {
    const apiReceipt = source(
      "app/api/admin/expenses/[expenseId]/receipt/route.ts",
    );
    const siteReceipt = source(
      "../site/src/app/api/team/expenses/[expenseId]/receipt/route.ts",
    );

    expect(apiReceipt).toContain('requirePermission(request, "expenses.read")');
    expect(apiReceipt).toContain('"Cache-Control": "private, no-store"');
    expect(siteReceipt).toContain('permissions: "expenses.read"');
    expect(siteReceipt).toContain('"Content-Disposition": `attachment;');
    expect(siteReceipt).toContain('"X-Content-Type-Options": "nosniff"');
    expect(siteReceipt).toContain("SAFE_RECEIPT_CONTENT_TYPES");
  });

  it("routes mobile expense submissions through review-aware V2 posting", () => {
    const mobilePage = source("../site/src/app/mobile/page.tsx");
    const mobileSpend = source("../site/src/app/mobile/MobileSpendV2.tsx");
    const mobileProxy = source(
      "../site/src/app/api/mobile/expenses/submissions/route.ts",
    );
    const submissionRoute = source(
      "app/api/admin/expenses/submissions/route.ts",
    );
    const submissionDomain = source("src/lib/expense-submissions.ts");

    expect(mobilePage).toContain("<MobileSpendV2");
    expect(mobileSpend).toContain('"/api/mobile/expenses/submissions"');
    expect(mobileSpend).toContain('"Idempotency-Key": idempotencyKey');
    expect(mobileSpend).toContain('"Submit for approval"');
    expect(mobileSpend).not.toContain(
      "/api/admin/expenses/${encodeURIComponent(expenseId)}/post",
    );
    expect(mobileProxy).toContain('permission: "expenses.submit"');
    expect(submissionRoute).toContain(
      'requiredPermissions: ["expenses.submit"]',
    );
    expect(submissionRoute).toContain("createExpenseSubmissionInTransaction");
    expect(submissionDomain).toContain(
      'const reviewStatus = input.canApprove ? "approved" : "pending"',
    );
    expect(submissionDomain).toContain(
      'lifecycleStatus: input.canApprove ? "posted" : "draft"',
    );
  });
});
