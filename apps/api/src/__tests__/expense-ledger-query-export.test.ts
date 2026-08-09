import fs from "node:fs";
import path from "node:path";
import {
  compareExpenseSortKeysNewestFirst,
  decodeExpenseCursor,
  encodeExpenseCursor,
  escapedExpenseSearchPattern,
  expenseSortKeyIsAfterCursor,
  parseExpenseQuery,
  type ExpenseSortKey,
} from "@/lib/expense-query";
import {
  csvCell,
  expenseCsvRow,
  neutralizeSpreadsheetFormula,
} from "@/lib/expense-export";
import {
  TEAM_PERMISSION_CATALOG,
  TEAM_READ_ONLY_PERMISSIONS,
} from "@myst-os/sdk";
import { getDefaultPermissionsForRole } from "@/lib/permissions";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

const paidAt = "2026-08-08T12:00:00.000Z";
const createdAt = "2026-08-08T13:00:00.000Z";
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

describe("expense ledger query and export contracts", () => {
  it("round-trips a versioned opaque cursor and rejects tampering", () => {
    const encoded = encodeExpenseCursor({ paidAt, createdAt, id: ids[1]! });
    expect(encoded).not.toContain(paidAt);
    expect(decodeExpenseCursor(encoded)).toEqual({
      version: 1,
      paidAt,
      createdAt,
      id: ids[1],
    });
    expect(decodeExpenseCursor(`${encoded}!`)).toBeNull();
    expect(
      decodeExpenseCursor(
        Buffer.from(
          JSON.stringify({
            version: 1,
            paidAt,
            createdAt,
            id: ids[1],
            injected: true,
          }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  it("uses the id tie-breaker when paid and created timestamps are identical", () => {
    const dense: ExpenseSortKey[] = ids.map((id) => ({
      paidAt,
      createdAt,
      id,
    }));
    const sorted = [...dense].sort(compareExpenseSortKeysNewestFirst);
    expect(sorted.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);

    const cursor = decodeExpenseCursor(
      encodeExpenseCursor({ paidAt, createdAt, id: ids[1]! }),
    );
    expect(cursor).not.toBeNull();
    expect(
      sorted.filter((row) => expenseSortKeyIsAfterCursor(row, cursor!)),
    ).toEqual([{ paidAt, createdAt, id: ids[0] }]);
  });

  it("strictly validates limits, cursors, directions, dates, and enumerations", () => {
    for (const [field, value] of [
      ["limit", "0"],
      ["limit", "101"],
      ["limit", "2.5"],
      ["cursor", ""],
      ["cursor", "not-a-cursor"],
      ["direction", "sideways"],
      ["from", "2026-02-31"],
      ["to", "08/08/2026"],
      ["status", "paid"],
      ["financeReview", "maybe"],
      ["unexpected", "true"],
    ]) {
      const parsed = parseExpenseQuery(
        new URLSearchParams({ [field!]: value! }),
      );
      expect(parsed).toEqual(expect.objectContaining({ ok: false }));
      if (!parsed.ok) expect(parsed.field).toBe(field);
    }
    expect(
      parseExpenseQuery(new URLSearchParams({ direction: "previous" })),
    ).toEqual(expect.objectContaining({ ok: false, field: "direction" }));
  });

  it("normalizes search fields and treats a date-only Through value as inclusive", () => {
    const parsed = parseExpenseQuery(
      new URLSearchParams({
        limit: "100",
        from: "2026-08-01",
        to: "2026-08-08",
        status: " POSTED ",
        category: "  Heavy   Equipment ",
        source: " MANUAL ",
        financeReview: " CLEAR ",
        q: "  Local   SUPPLIER ",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query).toEqual(
      expect.objectContaining({
        limit: 100,
        status: "posted",
        category: "heavy equipment",
        source: "manual",
        financeReview: "clear",
        q: "local supplier",
      }),
    );
    expect(parsed.query.from?.toISOString()).toBe("2026-08-01T04:00:00.000Z");
    expect(parsed.query.toExclusive?.toISOString()).toBe(
      "2026-08-09T04:00:00.000Z",
    );
  });

  it("treats search wildcard characters as literal text", () => {
    expect(escapedExpenseSearchPattern("100%_off!now")).toBe(
      "%100!%!_off!!now%",
    );
  });

  it("uses Eastern calendar days across the spring DST boundary", () => {
    const parsed = parseExpenseQuery(
      new URLSearchParams({ from: "2026-03-08", to: "2026-03-08" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.from?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(parsed.query.toExclusive?.toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });

  it("never silently applies list pagination fields to exports", () => {
    expect(
      parseExpenseQuery(new URLSearchParams({ limit: "25" }), {
        allowLimit: false,
        allowCursor: false,
      }),
    ).toEqual(expect.objectContaining({ ok: false, field: "limit" }));
    expect(
      parseExpenseQuery(new URLSearchParams({ direction: "next" }), {
        allowLimit: false,
        allowCursor: false,
      }),
    ).toEqual(expect.objectContaining({ ok: false, field: "direction" }));
  });

  it("neutralizes spreadsheet formulas without corrupting numeric reversals", () => {
    for (const value of [
      "=2+2",
      "+SUM(A1:A2)",
      "-cmd|' /C calc'!A0",
      "@now",
      "  =1+1",
    ]) {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
      expect(csvCell(value).startsWith("'")).toBe(true);
    }
    expect(csvCell(-123.45)).toBe("-123.45");
    expect(expenseCsvRow(["Vendor, Inc.", 'memo "quoted"'])).toBe(
      '"Vendor, Inc.","memo ""quoted"""',
    );
  });

  it("adds a dedicated export permission without granting it to crew or read-only", () => {
    expect(TEAM_PERMISSION_CATALOG).toContain("expenses.export");
    expect(TEAM_READ_ONLY_PERMISSIONS).not.toContain("expenses.export");
    expect(getDefaultPermissionsForRole("office")).toContain("expenses.export");
    expect(getDefaultPermissionsForRole("crew")).not.toContain(
      "expenses.export",
    );
  });

  it("enforces export at API, Site proxy, and rendered-control boundaries", () => {
    const api = source("app/api/admin/expenses/export/route.ts");
    const site = source("../site/src/app/api/team/expenses/export/route.ts");
    const ui = source("../site/src/app/team/components/ExpensesSection.tsx");
    expect(api).toContain('requirePermission(request, "expenses.export")');
    expect(api).toContain('requiredPermissions: ["expenses.export"]');
    expect(api).toContain('action: "expense.exported"');
    expect(api).not.toContain("receiptUrl");
    expect(api).not.toContain("receiptFilename");
    expect(site).toContain('permissions: "expenses.export"');
    expect(site).toContain('error: "malformed_expense_export"');
    expect(site).toContain('upstream.headers.get("x-export-row-count")');
    expect(site).toContain('upstream.headers.get("x-audit-correlation-id")');
    expect(ui).toContain('hasTeamPermission(principal, "expenses.export")');
    expect(ui).toContain("canExport ? <ExpenseExportButton");
  });

  it("keeps dense pages bounded and exposes truthful cursor metadata", () => {
    const api = source("app/api/admin/expenses/route.ts");
    const agentTools = source("../site/src/app/api/chat/jarvis-read-tools.ts");
    expect(api).toContain("desc(expenses.id)");
    expect(api).toContain("asc(expenses.id)");
    expect(api).toContain(".limit(query.limit + 1)");
    expect(api).toContain('"has_receipt"');
    expect(api).not.toContain("hasReceipt: expenses.receiptUrl");
    expect(api).toContain("hasPrevious");
    expect(api).toContain("previousCursor");
    expect(api).toContain("nextCursor");
    expect(agentTools).toContain(
      'Math.min(Math.max(asInt(args["limit"], 25), 1), 100)',
    );
  });

  it("renders distinct URL, denied, network, server, malformed, and true-empty states", () => {
    const ui = source("../site/src/app/team/components/ExpensesSection.tsx");
    const page = source("../site/src/app/team/page.tsx");
    expect(ui).toContain("Invalid expense URL");
    expect(ui).toContain("Ledger access denied");
    expect(ui).toContain("Ledger unavailable offline");
    expect(ui).toContain("Ledger service error");
    expect(ui).toContain("Invalid ledger response");
    expect(ui).toContain("The ledger loaded successfully");
    expect(ui).toContain('name="expenseView" value="ledger"');
    expect(ui).toContain('aria-label="Expense ledger pages"');
    expect(page).toContain('canonicalSearch.set("expenseView", "ledger")');
  });

  it("registers the office export baseline as migration 0079", () => {
    const migration = source(
      "src/db/migrations/0079_expense_ledger_query_export.sql",
    );
    const journal = source("src/db/migrations/meta/_journal.json");
    expect(migration).toContain("ARRAY['expenses.export']");
    expect(migration).toContain("lower(trim(slug)) = 'office'");
    expect(migration).toContain('"expenses_ledger_cursor_idx"');
    expect(journal).toContain('"tag": "0079_expense_ledger_query_export"');
  });
});
