import { jest } from "@jest/globals";
import type { NextRequest } from "next/server";
import type { requirePermission } from "@/lib/permissions";
import type { getOpenAiAdsReport } from "@/lib/openai-ads-reporting";

const mockRequirePermission = jest.fn<typeof requirePermission>();
const mockReport = jest.fn<typeof getOpenAiAdsReport>();
const actualReportModule = await import("@/lib/openai-ads-reporting");
jest.unstable_mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.unstable_mockModule("@/lib/openai-ads-reporting", () => ({
  ...actualReportModule,
  getOpenAiAdsReport: mockReport,
}));
const { GET } = await import("../../app/api/admin/openai/ads/reporting/route");

function request(rangeDays?: string): NextRequest {
  const url = new URL("https://api.example/api/admin/openai/ads/reporting");
  if (rangeDays !== undefined) url.searchParams.set("rangeDays", rangeDays);
  return new Request(url) as NextRequest;
}

describe("authorized OpenAI Ads reporting endpoint", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    // UTC has entered Nov 2; the shared Eastern calendar window is still Nov 1 (DST ends).
    jest.setSystemTime(new Date("2026-11-02T03:00:00Z"));
    mockRequirePermission.mockResolvedValue(null);
    mockReport.mockImplementation((timeframe) =>
      Promise.resolve({
        ok: true,
        configured: true,
        account: {
          id: "adacct_1",
          name: "Company",
          currency: "USD",
          timeZone: "America/New_York",
        },
        timeframe,
        fetchedAt: new Date().toISOString(),
        totals: {
          spend: 2,
          impressions: 10,
          clicks: 1,
          attributedConversions: null,
          bookingConversions: null,
          phoneInquiryConversions: null,
          costPerConversion: null,
        },
        campaigns: [],
        conversionBreakdownAvailable: false,
        notes: [],
      }),
    );
  });
  afterEach(() => jest.useRealTimers());

  it.each([401, 403])(
    "requires the existing marketing.read authorization before retrieving provider data (%i)",
    async (status) => {
      mockRequirePermission.mockResolvedValue(
        new Response("denied", { status }),
      );
      const incoming = request();
      expect((await GET(incoming)).status).toBe(status);
      expect(mockRequirePermission).toHaveBeenCalledWith(
        incoming,
        "marketing.read",
      );
      expect(mockReport).not.toHaveBeenCalled();
    },
  );

  it.each([
    [undefined, "2026-10-26"],
    ["1", "2026-11-01"],
    ["7", "2026-10-26"],
    ["14", "2026-10-19"],
    ["30", "2026-10-03"],
  ])(
    "matches the inclusive Eastern calendar preset %s across a DST boundary",
    async (rangeDays, since) => {
      const response = await GET(request(rangeDays));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mockReport).toHaveBeenCalledWith(
        expect.objectContaining({
          since,
          through: "2026-11-01",
          timezone: "America/New_York",
        }),
      );
      expect(await response.json()).toMatchObject({
        ok: true,
        timeframe: { since, through: "2026-11-01" },
      });
    },
  );

  it.each(["0", "2", "31", "7.0", "07", "all"])(
    "rejects unsupported range %s before provider access",
    async (rangeDays) => {
      const response = await GET(request(rangeDays));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "invalid_range_days",
      });
      expect(mockReport).not.toHaveBeenCalled();
    },
  );

  it("distinguishes missing advertiser configuration from an empty valid report", async () => {
    mockReport.mockRejectedValue(
      new actualReportModule.OpenAiAdsReportingError(
        "openai_ads_reporting_not_configured",
        503,
      ),
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      configured: false,
      error: "openai_ads_reporting_not_configured",
    });
  });

  it("returns safe provider errors without leaking auth values or arbitrary exceptions", async () => {
    mockReport.mockRejectedValueOnce(
      new actualReportModule.OpenAiAdsReportingError(
        "openai_ads_reporting_http_401",
        502,
      ),
    );
    const providerFailure = await GET(request());
    expect(providerFailure.status).toBe(502);
    expect(await providerFailure.json()).toEqual({
      ok: false,
      configured: true,
      error: "openai_ads_reporting_http_401",
    });
    mockReport.mockRejectedValueOnce(new Error("sensitive credentials"));
    const unexpected = await GET(request());
    expect(unexpected.status).toBe(503);
    expect(await unexpected.json()).toEqual({
      ok: false,
      configured: true,
      error: "openai_ads_reporting_unavailable",
    });
  });
});
