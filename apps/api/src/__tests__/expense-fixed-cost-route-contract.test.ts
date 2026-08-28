import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("fixed-cost financial route contract", () => {
  const collection = source("app/api/admin/expenses/fixed-costs/route.ts");
  const member = source(
    "app/api/admin/expenses/fixed-costs/[fixedCostId]/route.ts",
  );
  const capabilities = source("app/api/admin/expenses/capabilities/route.ts");
  const submissions = source("app/api/admin/expenses/submissions/route.ts");
  const review = source(
    "app/api/admin/expenses/submissions/[expenseId]/review/route.ts",
  );
  const confirmation = source(
    "app/api/admin/expenses/captures/[captureId]/confirm/route.ts",
  );
  const correction = source(
    "app/api/admin/expenses/[expenseId]/correct/route.ts",
  );
  const voidRoute = source("app/api/admin/expenses/[expenseId]/void/route.ts");
  const ledger = source("app/api/admin/expenses/route.ts");
  const expenseExport = source("app/api/admin/expenses/export/route.ts");

  it("keeps reads financial-only and mutations owner-controlled", () => {
    expect(collection).toContain(
      'requirePermission(request, "financials.read")',
    );
    for (const route of [collection, member]) {
      expect(route).toContain(
        'requiredPermissions: ["financials.read", "expenses.approve"]',
      );
      expect(route).toContain('risk: "financial"');
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("isExpenseFixedCostsEnabled()");
      expect(route).toContain("claimTeamMutationIdempotency");
      expect(route).toContain("completeTeamMutationIdempotency");
      expect(route).toContain("mutation.audit.insertSuccess");
    }
    expect(member).toContain("mutation.expectedVersion");
    expect(member).not.toMatch(/export async function DELETE/u);
  });

  it("exposes management only when approval, financial read, and flag agree", () => {
    expect(capabilities).toMatch(
      /fixedCosts:\s*canApprove && canReadFinancials && isExpenseFixedCostsEnabled\(\)/u,
    );
  });

  it("uses bounded duplicate-key-safe request parsing and no-store responses", () => {
    for (const route of [collection, member]) {
      expect(route).toContain("readBoundedJsonRequest");
      expect(route).toContain("rejectDuplicateObjectKeys: true");
      expect(route).toContain(
        '"Cache-Control": "private, no-store, max-age=0"',
      );
    }
  });

  it("returns fixed-cost coverage only to financial readers", () => {
    expect(submissions).toContain(
      "coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId",
    );
    expect(submissions).toContain(
      "ORDER BY ${expenseFixedCostVersions.effectiveStartDate} DESC, ${expenseFixedCostVersions.version} DESC",
    );
    expect(submissions).toMatch(
      /coveredByFixedCostSeriesId:\s*access\.canReadFinancials\s*\?\s*row\.coveredByFixedCostSeriesId\s*:\s*null/u,
    );
    expect(submissions).toMatch(
      /coveredByFixedCostName:\s*access\.canReadFinancials\s*\?\s*row\.coveredByFixedCostName\s*:\s*null/u,
    );
    expect(review).toContain(
      "coveredByFixedCostSeriesId: reviewed.coveredByFixedCostSeriesId",
    );
  });

  it("requires financial access in every coverage-link mutation path", () => {
    expect(submissions).toContain(
      "access.canApprove && access.canReadFinancials",
    );
    for (const route of [confirmation, review, correction]) {
      expect(route).toContain(
        'permissionMatches(permission, "financials.read")',
      );
      expect(route).toContain("canManageFixedCostCoverage");
    }
  });

  it("records coverage context when linked evidence is voided", () => {
    expect(voidRoute).toMatch(
      /coveredByFixedCostSeriesId:\s*existing\.coveredByFixedCostSeriesId/u,
    );
    expect(voidRoute).toContain("reversalCoveredByFixedCostSeriesId: null");
  });

  it("keeps linked-payment evidence reconcilable in the ledger and CSV export", () => {
    for (const route of [ledger, expenseExport]) {
      expect(route).toContain(
        "coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId",
      );
    }
    expect(ledger).toContain("coveredByFixedCostName");
    expect(expenseExport).toContain('"Fixed-cost name"');
    expect(expenseExport).toContain(
      "Excluded from ordinary Overview expenses; fixed-cost accrual counted instead",
    );
  });
});
