import { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockExecute = jest.fn();
const mockGetDb = jest.fn(() => ({ execute: mockExecute }));
const mockSql = jest.fn(
  (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
);

jest.mock("drizzle-orm", () => ({ sql: mockSql }));
jest.mock("@/db", () => ({ getDb: mockGetDb }));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

import { GET } from "../../app/api/admin/web/analytics/funnel/route";

type CapturedSql = {
  strings: string[];
  values: unknown[];
};

function requestFor(rangeDays?: string): NextRequest {
  const url = new URL(
    "https://api.example.test/api/admin/web/analytics/funnel",
  );
  if (rangeDays !== undefined) url.searchParams.set("rangeDays", rangeDays);
  return new NextRequest(url);
}

describe("website analytics funnel route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-09T16:00:00.000Z"));
    mockRequirePermission.mockResolvedValue(null);
    mockExecute.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ["1", "2026-08-09T04:00:00.000Z"],
    ["7", "2026-08-03T04:00:00.000Z"],
    ["14", "2026-07-27T04:00:00.000Z"],
    ["30", "2026-07-11T04:00:00.000Z"],
  ])(
    "binds the supported %s-day range as a postgres-safe timestamp string",
    async (rangeDays, expectedTimestamp) => {
      const response = await GET(requestFor(rangeDays));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        rangeDays: Number(rangeDays),
        since: expectedTimestamp.slice(0, 10),
      });
      expect(mockExecute).toHaveBeenCalledTimes(1);

      const executeCalls = mockExecute.mock.calls as Array<[CapturedSql]>;
      const query = executeCalls[0]?.[0];
      expect(query).toBeDefined();
      if (!query) throw new Error("Expected the funnel SQL query to execute");
      expect(query.values).toEqual([expectedTimestamp, expectedTimestamp]);
      expect(query.values.some((value) => value instanceof Date)).toBe(false);
      expect(query.strings.join("?")).toContain(
        "created_at >= ?::timestamptz",
      );
      expect(query.strings.join("?").match(/\?::timestamptz/gu)).toHaveLength(
        2,
      );
    },
  );

  it.each(["0", "2", "31", "7.0", "07", "all"])(
    "returns a truthful validation error for unsupported range %s",
    async (rangeDays) => {
      const response = await GET(requestFor(rangeDays));

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        ok: false,
        error: "invalid_range",
        allowedRangeDays: [1, 7, 14, 30],
      });
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );

  it("reports query failures as unavailable instead of returning empty totals", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockExecute.mockRejectedValueOnce(new TypeError("driver rejected input"));

    const response = await GET(requestFor("7"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "funnel_unavailable",
      message:
        "Funnel analytics could not be loaded. No funnel counts are being shown as complete.",
      retryable: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[website-analytics-funnel] query_failed",
      { errorName: "TypeError" },
    );
  });
});
