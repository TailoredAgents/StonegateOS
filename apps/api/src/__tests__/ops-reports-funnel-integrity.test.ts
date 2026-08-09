const mockExecute = jest.fn();
const mockGetDb = jest.fn(() => ({ execute: mockExecute }));
const mockSql = jest.fn(
  (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
);

jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  desc: jest.fn(),
  eq: jest.fn(),
  gte: jest.fn(),
  sql: mockSql,
}));
jest.mock("../db", () => ({
  appointments: {},
  getDb: mockGetDb,
  googleAdsInsightsDaily: {},
  webEventCountsDaily: {},
}));
jest.mock("../lib/google-ads-insights", () => ({
  getGoogleAdsConfiguredIds: jest.fn(() => ({ customerId: null })),
}));

import {
  fetchWebFunnelByBucket,
  OpsReportFunnelUnavailableError,
} from "../lib/ops-reports";

type CapturedSql = {
  strings: string[];
  values: unknown[];
};

describe("ops report funnel integrity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-11-01T17:30:00.000Z"));
    mockExecute.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [1, "2026-11-01T04:00:00.000Z"],
    [7, "2026-10-26T04:00:00.000Z"],
    [30, "2026-10-03T04:00:00.000Z"],
  ])(
    "binds the %s-day Eastern window as timestamp strings in both predicates",
    async (rangeDays, expectedTimestamp) => {
      const result = await fetchWebFunnelByBucket({
        rangeDays,
        tz: "America/New_York",
      });

      expect(result).toMatchObject({
        rangeDays,
        since: expectedTimestamp.slice(0, 10),
        totals: {
          step1Views: 0,
          step2Views: 0,
          step1Submits: 0,
          quoteSuccess: 0,
          bookingSuccess: 0,
        },
      });
      expect(mockExecute).toHaveBeenCalledTimes(1);

      const executeCalls = mockExecute.mock.calls as Array<[CapturedSql]>;
      const query = executeCalls[0]?.[0];
      expect(query).toBeDefined();
      if (!query) throw new Error("Expected the ops funnel SQL to execute");
      expect(query.values).toEqual([expectedTimestamp, expectedTimestamp]);
      expect(query.values.some((value) => value instanceof Date)).toBe(false);
      expect(query.strings.join("?").match(/\?::timestamptz/gu)).toHaveLength(
        2,
      );
    },
  );

  it("propagates a typed unavailable failure instead of fabricating empty counts", async () => {
    const driverFailure = new TypeError("driver rejected input");
    mockExecute.mockRejectedValueOnce(driverFailure);

    const operation = fetchWebFunnelByBucket({
      rangeDays: 7,
      tz: "America/New_York",
    });

    await expect(operation).rejects.toMatchObject({
      name: "OpsReportFunnelUnavailableError",
      code: "ops_report_funnel_unavailable",
      retryable: true,
      cause: driverFailure,
    });
    await expect(operation).rejects.toBeInstanceOf(
      OpsReportFunnelUnavailableError,
    );
  });
});
