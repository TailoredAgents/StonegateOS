import type { NextRequest } from "next/server";

const mockGetDb = jest.fn();
const mockRequirePermission = jest.fn();
const mockIsAdminRequest = jest.fn();
const mockIsExpenseOverviewEnabled = jest.fn();
const mockLoadExpenseOverviewInput = jest.fn();

jest.mock("@/db", () => ({ getDb: mockGetDb }));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("@/lib/expense-feature-flags", () => ({
  isExpenseOverviewEnabled: mockIsExpenseOverviewEnabled,
}));
jest.mock("@/lib/expense-overview-repository", () => ({
  loadExpenseOverviewInput: mockLoadExpenseOverviewInput,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import { GET } from "../../app/api/admin/expenses/overview/route";

const WEEK_START = "2026-08-17";

function request(weekStart?: string): NextRequest {
  const url = new URL("https://api.example.test/api/admin/expenses/overview");
  if (weekStart !== undefined) url.searchParams.set("weekStart", weekStart);
  const raw = new Request(url, { headers: { host: url.host } });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

function calculatorInput() {
  return {
    weekStart: WEEK_START,
    jobs: [],
    expenses: [],
    commissions: [],
    payrollAdjustments: [],
    payoutSnapshots: [],
    dailyAdEntries: [],
    pendingExpenseCount: 0,
    asOf: "2026-08-24",
  };
}

describe("weekly expense overview route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockIsExpenseOverviewEnabled.mockReturnValue(true);
    mockGetDb.mockReturnValue({ kind: "db" });
    mockLoadExpenseOverviewInput.mockResolvedValue(calculatorInput());
  });

  it("rejects a non-admin request before permission or query access", async () => {
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
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(queryRead).toBe(false);
  });

  it("requires financials.read before feature, query, or database access", async () => {
    const denial = Response.json({ error: "forbidden" }, { status: 403 });
    mockRequirePermission.mockResolvedValue(denial);
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

    expect(response).toBe(denial);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      deniedRequest,
      "financials.read",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockIsExpenseOverviewEnabled).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(queryRead).toBe(false);
  });

  it("fails closed while the Overview feature flag is disabled", async () => {
    mockIsExpenseOverviewEnabled.mockReturnValue(false);

    const response = await GET(request(WEEK_START));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "expense_overview_disabled",
      retryable: false,
    });
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it.each([undefined, "2026-08-18", "08/17/2026"])(
    "rejects an absent or invalid Eastern Monday (%s) without querying",
    async (weekStart) => {
      const response = await GET(request(weekStart));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          error: "invalid_week_start",
          field: "weekStart",
        }),
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockLoadExpenseOverviewInput).not.toHaveBeenCalled();
    },
  );

  it("loads an arbitrary valid week and returns the precise no-store contract", async () => {
    const overviewRequest = request(WEEK_START);

    const response = await GET(overviewRequest);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mockRequirePermission).toHaveBeenCalledWith(
      overviewRequest,
      "financials.read",
    );
    expect(mockLoadExpenseOverviewInput).toHaveBeenCalledTimes(1);
    const loadCall = mockLoadExpenseOverviewInput.mock.calls[0] as unknown as [
      { kind: string },
      string,
      { asOf: Date },
    ];
    expect(loadCall[0]).toEqual({ kind: "db" });
    expect(loadCall[1]).toBe(WEEK_START);
    expect(loadCall[2].asOf).toBeInstanceOf(Date);
    expect(body).toMatchObject({
      ok: true,
      currency: "USD",
      revenueCents: 0,
      ordinaryExpensesCents: 0,
      laborCents: 0,
      totalExpensesCents: 0,
      operatingProfitCents: 0,
      expenseRatioPercent: null,
      week: {
        timezone: "America/New_York",
        startDate: WEEK_START,
        endDate: "2026-08-23",
      },
      reportingBasis: {
        advertising:
          "Manual daily entries only; provider analytics are excluded.",
      },
    });
  });

  it("returns a safe no-store failure when repository reconciliation fails", async () => {
    mockLoadExpenseOverviewInput.mockRejectedValue(
      new Error("private database detail"),
    );
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const response = await GET(request(WEEK_START));
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      error: "expense_overview_failed",
      message: "The weekly expense overview could not be loaded. Try again.",
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
    consoleError.mockRestore();
  });
});
