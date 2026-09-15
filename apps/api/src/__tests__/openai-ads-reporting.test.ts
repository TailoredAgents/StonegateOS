import { jest } from "@jest/globals";
import { DateTime } from "luxon";
import {
  getOpenAiAdsReport,
  OPENAI_ADS_REPORTING_TIMEOUT_MS,
} from "@/lib/openai-ads-reporting";
import { buildWebsiteAnalyticsWindow } from "@/lib/web-analytics-reporting";

const environment = { OPENAI_ADS_API_KEY: "advertiser-server-only-test-key" };
const now = new Date("2026-09-15T18:00:00Z");
const { timeframe } = buildWebsiteAnalyticsWindow(7, DateTime.fromJSDate(now));
const account = {
  id: "adacct_1",
  name: "Example company",
  currency_code: "USD",
  timezone: "America/Los_Angeles",
};
const delivery = {
  impressions: 120,
  clicks: 7,
  spend: 12.34,
  conversions: 2,
  cpa: 6.17,
};
const campaign = {
  campaign_id: "campaign_1",
  campaign_name: "Campaign one",
  campaign_status: "active",
  ...delivery,
};

function page(data: unknown[], hasMore = false, cursor?: string) {
  return { object: "list", data, has_more: hasMore, last_id: cursor ?? null };
}

function provider(
  options: { account?: unknown; totals?: unknown; pages?: unknown[] } = {},
) {
  let campaignPage = 0;
  return jest.fn<typeof fetch>().mockImplementation((input) => {
    if (!(input instanceof URL)) throw new Error("Expected URL");
    const value =
      input.pathname === "/v1/ad_account"
        ? (options.account ?? account)
        : input.searchParams.get("aggregation_level") === "ad_account"
          ? (options.totals ?? page([delivery]))
          : (options.pages ?? [page([campaign])])[campaignPage++];
    return Promise.resolve(new Response(JSON.stringify(value)));
  });
}

describe("read-only OpenAI advertiser reports", () => {
  afterEach(() => jest.useRealTimers());

  it("requests fixed GET endpoints with server auth and reports major units and combined attributed conversions", async () => {
    const fetchImpl = provider();
    const result = await getOpenAiAdsReport(timeframe, {
      environment: {
        ...environment,
        OPENAI_ADS_API_BASE_URL: "https://untrusted.example",
      },
      fetchImpl,
      now: () => now,
    });
    expect(result).toMatchObject({
      ok: true,
      configured: true,
      account: {
        id: account.id,
        name: account.name,
        currency: "USD",
        timeZone: account.timezone,
      },
      timeframe,
      fetchedAt: now.toISOString(),
      totals: {
        spend: 12.34,
        impressions: 120,
        clicks: 7,
        attributedConversions: 2,
        costPerConversion: 6.17,
        bookingConversions: null,
        phoneInquiryConversions: null,
      },
      campaigns: [
        {
          id: campaign.campaign_id,
          name: campaign.campaign_name,
          status: "active",
          attributedConversions: 2,
        },
      ],
      conversionBreakdownAvailable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchImpl.mock.calls) {
      if (!(url instanceof URL)) throw new Error("Expected URL");
      expect(url.origin).toBe("https://api.ads.openai.com");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${environment.OPENAI_ADS_API_KEY}` },
      });
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(url.toString()).not.toContain(environment.OPENAI_ADS_API_KEY);
      if (url.pathname.endsWith("/insights")) {
        expect(
          JSON.parse(url.searchParams.get("time_ranges[]")!) as unknown,
        ).toEqual({
          type: "date_range",
          since: "2026-09-09",
          until: "2026-09-15",
          timezone: "America/New_York",
        });
        expect(url.searchParams.get("time_granularity")).toBe("none");
        expect(url.searchParams.getAll("fields[]")).toEqual(
          expect.arrayContaining(["conversions", "cpa"]),
        );
        expect(url.searchParams.getAll("includes[]")).toEqual([
          "zero_impression_items",
        ]);
      }
    }
    expect(JSON.stringify(result)).not.toContain(
      environment.OPENAI_ADS_API_KEY,
    );
  });

  it("does not use the conversion key as an advertiser credential", async () => {
    const fetchImpl = provider();
    await expect(
      getOpenAiAdsReport(timeframe, {
        environment: { OPENAI_ADS_CONVERSIONS_API_KEY: "conversion-key" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "openai_ads_reporting_not_configured",
      status: 503,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { E2E_RUN_ID: "audit" },
    { NODE_ENV: "production", E2E_RUN_ID: "incomplete-audit" },
    { NODE_ENV: "production", E2E_RUN_ID: "audit", TEAM_CRM_AUDIT_MODE: "1" },
  ])(
    "blocks real provider access in controlled tests: %j",
    async (overrides) => {
      const fetchImpl = provider();
      await expect(
        getOpenAiAdsReport(timeframe, {
          environment: { ...environment, ...overrides },
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        code: "openai_ads_reporting_test_runtime_blocked",
        status: 503,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("preserves missing delivery and conversion metrics as unavailable while retaining known metrics", async () => {
    const fetchImpl = provider({
      totals: page([{ spend: null, clicks: 0 }]),
      pages: [
        page([{ campaign_id: "campaign_1", spend: 2.75, impressions: null }]),
      ],
    });
    const result = await getOpenAiAdsReport(timeframe, {
      environment,
      fetchImpl,
    });
    expect(result.totals).toEqual({
      spend: null,
      impressions: null,
      clicks: 0,
      attributedConversions: null,
      costPerConversion: null,
      bookingConversions: null,
      phoneInquiryConversions: null,
    });
    expect(result.campaigns[0]).toMatchObject({
      name: "Unnamed campaign",
      status: null,
      spend: 2.75,
      clicks: null,
      impressions: null,
      attributedConversions: null,
    });
  });

  it("keeps true zero results and never invents totals when there are no report rows", async () => {
    const empty = await getOpenAiAdsReport(timeframe, {
      environment,
      fetchImpl: provider({ totals: page([]), pages: [page([])] }),
    });
    expect(empty.totals.spend).toBeNull();
    expect(empty.totals.attributedConversions).toBeNull();
    expect(empty.campaigns).toEqual([]);
    const zero = await getOpenAiAdsReport(timeframe, {
      environment,
      fetchImpl: provider({
        totals: page([
          { spend: 0, clicks: 0, impressions: 0, conversions: 0, cpa: null },
        ]),
      }),
    });
    expect(zero.totals).toMatchObject({
      spend: 0,
      clicks: 0,
      impressions: 0,
      attributedConversions: 0,
      costPerConversion: null,
    });
  });

  it("follows opaque cursors without using campaign sums in place of provider account totals", async () => {
    const fetchImpl = provider({
      pages: [
        page([campaign], true, "opaque/cursor+token"),
        page([{ ...campaign, campaign_id: "campaign_2" }]),
      ],
    });
    const result = await getOpenAiAdsReport(timeframe, {
      environment,
      fetchImpl,
    });
    expect(result.campaigns).toHaveLength(2);
    expect(result.totals.spend).toBe(12.34);
    const urls = fetchImpl.mock.calls.map(([input]) =>
      input instanceof URL ? input : null,
    );
    expect(
      urls
        .find((url) => url?.searchParams.has("after"))
        ?.searchParams.get("after"),
    ).toBe("opaque/cursor+token");
  });

  it.each([
    { conversions: 0, cpa: 0, expected: null },
    { conversions: null, cpa: 3, expected: null },
    { conversions: 2, cpa: 0, expected: 0 },
    { conversions: 2, cpa: 6.17, expected: 6.17 },
  ])(
    "shows a cost per conversion only when conversions exist: %j",
    async ({ conversions, cpa, expected }) => {
      const result = await getOpenAiAdsReport(timeframe, {
        environment,
        fetchImpl: provider({
          totals: page([{ ...delivery, conversions, cpa }]),
        }),
      });
      expect(result.totals.costPerConversion).toBe(expected);
    },
  );

  it.each([
    { totals: page([{ spend: "12.34" }]) },
    { totals: page([{ impressions: -1 }]) },
    { totals: page([{ clicks: 0.5 }]) },
    { totals: page([{ conversions: "2" }]) },
    { totals: page([delivery, delivery]) },
    { totals: page([delivery], true, "more") },
    { account: { ...account, currency_code: "bogus" } },
    { pages: [page([{ ...campaign, spend: -1 }])] },
    { pages: [page([campaign, campaign])] },
    { pages: [page([campaign], true)] },
    { pages: [page([], true, "more")] },
    {
      pages: [
        page([campaign], true, "repeat"),
        page([{ ...campaign, campaign_id: "other" }], true, "repeat"),
      ],
    },
  ])(
    "rejects malformed or incomplete reports instead of showing misleading data: %j",
    async (options) => {
      await expect(
        getOpenAiAdsReport(timeframe, {
          environment,
          fetchImpl: provider(options),
        }),
      ).rejects.toMatchObject({
        code: "openai_ads_reporting_invalid_response",
        status: 502,
      });
    },
  );

  it("does not silently truncate a report exceeding the page bound", async () => {
    const pages = Array.from({ length: 5 }, (_, index) =>
      page(
        [{ ...campaign, campaign_id: `campaign_${index}` }],
        true,
        `cursor_${index}`,
      ),
    );
    await expect(
      getOpenAiAdsReport(timeframe, {
        environment,
        fetchImpl: provider({ pages }),
      }),
    ).rejects.toMatchObject({ code: "openai_ads_reporting_incomplete" });
  });

  it.each([401, 403, 429, 500, 503])(
    "returns sanitized HTTP %i failures without provider bodies or credentials",
    async (status) => {
      const fetchImpl = jest.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          new Response(`private-body ${environment.OPENAI_ADS_API_KEY}`, {
            status,
          }),
        ),
      );
      await expect(
        getOpenAiAdsReport(timeframe, { environment, fetchImpl }),
      ).rejects.toMatchObject({
        code: `openai_ads_reporting_http_${status}`,
        message: `openai_ads_reporting_http_${status}`,
        status: status === 429 || status >= 500 ? 503 : 502,
      });
    },
  );

  it("sanitizes unexpected network errors", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(`private details ${environment.OPENAI_ADS_API_KEY}`),
      );
    await expect(
      getOpenAiAdsReport(timeframe, { environment, fetchImpl }),
    ).rejects.toMatchObject({
      code: "openai_ads_reporting_unavailable",
      message: "openai_ads_reporting_unavailable",
    });
  });

  it.each(["not-json", "x".repeat(2 * 1024 * 1024 + 1)])(
    "rejects invalid JSON or oversized streamed response",
    async (body) => {
      const fetchImpl = jest
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(new Response(body)));
      await expect(
        getOpenAiAdsReport(timeframe, { environment, fetchImpl }),
      ).rejects.toMatchObject({
        code: "openai_ads_reporting_invalid_response",
      });
    },
  );

  it("aborts all pending provider requests using one bounded deadline", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const result = getOpenAiAdsReport(timeframe, { environment, fetchImpl });
    const assertion = expect(result).rejects.toMatchObject({
      code: "openai_ads_reporting_timeout",
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(OPENAI_ADS_REPORTING_TIMEOUT_MS);
    await assertion;
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.signal?.aborted),
    ).toBe(true);
  });
});
