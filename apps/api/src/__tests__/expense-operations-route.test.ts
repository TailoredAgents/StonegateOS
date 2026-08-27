import type { NextRequest } from "next/server";

const mockGetDb = jest.fn();
const mockRequirePermission = jest.fn();
const mockIsAdminRequest = jest.fn();
const mockParseQuery = jest.fn();
const mockReadMonitor = jest.fn();

class MockExpenseOperationsMonitorInputError extends Error {
  constructor(
    readonly field: "lookbackDays" | "overviewWeeks",
    message: string,
  ) {
    super(message);
    this.name = "ExpenseOperationsMonitorInputError";
  }
}

jest.mock("@/db", () => ({ getDb: mockGetDb }));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("@/lib/expense-operations-monitor", () => ({
  ExpenseOperationsMonitorInputError: MockExpenseOperationsMonitorInputError,
  parseExpenseOperationsMonitorQuery: mockParseQuery,
  readExpenseOperationsMonitor: mockReadMonitor,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import { GET } from "../../app/api/admin/expenses/operations/route";

function request(query = ""): NextRequest {
  const url = new URL(
    `https://api.example.test/api/admin/expenses/operations${query}`,
  );
  const raw = new Request(url);
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

describe("expense operations monitoring route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockParseQuery.mockReturnValue({ lookbackDays: 30, overviewWeeks: 4 });
    mockGetDb.mockReturnValue({ kind: "db" });
    mockReadMonitor.mockResolvedValue({
      generatedAt: "2026-08-27T14:00:00.000Z",
      receipts: {
        statusCounts: { queued: 1 },
        oldestQueued: {
          captureId: "11111111-1111-4111-8111-111111111111",
        },
      },
      approvals: { pendingCount: 2 },
      reimbursements: { count: 1 },
      advertising: { missingPlatforms: ["google"] },
      recentOverviewWeeks: { incompleteCount: 1 },
    });
  });

  it("rejects non-admin callers before permissions, query parsing, or database access", async () => {
    mockIsAdminRequest.mockReturnValue(false);
    let queryRead = false;
    const deniedRequest = Object.defineProperty(
      { headers: new Headers() },
      "nextUrl",
      {
        get() {
          queryRead = true;
          throw new Error("query should not be read");
        },
      },
    ) as NextRequest;

    const response = await GET(deniedRequest);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockRequirePermission).not.toHaveBeenCalled();
    expect(mockParseQuery).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(queryRead).toBe(false);
  });

  it("requires both owner financial and approval permissions before parsing", async () => {
    const denial = Response.json({ error: "forbidden" }, { status: 403 });
    mockRequirePermission.mockResolvedValue(denial);
    const deniedRequest = request("?lookbackDays=30");

    const response = await GET(deniedRequest);

    expect(response).toBe(denial);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockRequirePermission).toHaveBeenCalledWith(
      deniedRequest,
      ["financials.read", "expenses.approve"],
      { mode: "all" },
    );
    expect(mockParseQuery).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("returns a no-store validation response without opening the database", async () => {
    mockParseQuery.mockImplementation(() => {
      throw new MockExpenseOperationsMonitorInputError(
        "lookbackDays",
        "lookbackDays must be from 1 through 90.",
      );
    });

    const response = await GET(request("?lookbackDays=365"));

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      error: "invalid_expense_operations_query",
      field: "lookbackDays",
      message: "lookbackDays must be from 1 through 90.",
    });
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockReadMonitor).not.toHaveBeenCalled();
  });

  it("returns only the aggregate monitor contract with private no-store headers", async () => {
    const monitorRequest = request("?lookbackDays=14&overviewWeeks=4");
    const response = await GET(monitorRequest);
    const body = (await response.json()) as {
      ok?: unknown;
      monitor?: {
        approvals?: unknown;
        advertising?: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(mockParseQuery).toHaveBeenCalledWith(
      monitorRequest.nextUrl.searchParams,
    );
    expect(mockReadMonitor).toHaveBeenCalledWith(
      { kind: "db" },
      { lookbackDays: 30, overviewWeeks: 4 },
    );
    expect(body.ok).toBe(true);
    expect(body.monitor?.approvals).toEqual({ pendingCount: 2 });
    expect(body.monitor?.advertising).toEqual({
      missingPlatforms: ["google"],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("extraction");
    expect(serialized).not.toContain("contentPath");
    expect(serialized).not.toContain("filename");
  });

  it("redacts database failures and preserves no-store headers", async () => {
    mockReadMonitor.mockRejectedValue(new Error("private database detail"));
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const response = await GET(request());
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      error: "expense_operations_unavailable",
      message: "Expense operations metrics could not be loaded. Try again.",
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
    consoleError.mockRestore();
  });
});
