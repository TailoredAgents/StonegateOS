import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import {
  isAnalyticsIdentifierKey,
  sanitizeAnalyticsProviderEventName,
  sanitizeAnalyticsProviderParams,
  sanitizeFirstPartyAnalyticsMeta,
} from "../lib/analytics-privacy";
import { sendConversion } from "../lib/ga";
import {
  buildWebsiteAnalyticsWindow,
  parseWebsiteAnalyticsRangeDays,
  WEBSITE_ANALYTICS_RANGE_DAYS,
} from "../lib/web-analytics-reporting";
import {
  advertisingContextHref,
  normalizeAdvertisingContext,
  normalizeWebsiteAnalyticsRange,
  websiteAnalyticsHref,
} from "../../../site/src/app/team/components/website-analytics-view";

const ROOT = join(process.cwd(), "../..");
const SITE_COMPONENT = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/WebAnalyticsSection.tsx"),
  "utf8",
);
const PUBLIC_INGEST = readFileSync(
  join(ROOT, "apps/api/app/api/public/web-events/route.ts"),
  "utf8",
);
const GA_ADAPTER = readFileSync(join(ROOT, "apps/api/src/lib/ga.ts"), "utf8");

const REPORT_ROUTES = ["summary", "funnel", "errors", "vitals"].map((panel) =>
  readFileSync(
    join(ROOT, `apps/api/app/api/admin/web/analytics/${panel}/route.ts`),
    "utf8",
  ),
);

describe("Website Analytics experience", () => {
  const originalMeasurementId = process.env["GA4_MEASUREMENT_ID"];
  const originalApiSecret = process.env["GA4_API_SECRET"];

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalMeasurementId === undefined) {
      delete process.env["GA4_MEASUREMENT_ID"];
    } else {
      process.env["GA4_MEASUREMENT_ID"] = originalMeasurementId;
    }
    if (originalApiSecret === undefined) {
      delete process.env["GA4_API_SECRET"];
    } else {
      process.env["GA4_API_SECRET"] = originalApiSecret;
    }
  });

  it("accepts exactly the 1, 7, 14, and 30 day ranges", () => {
    expect(WEBSITE_ANALYTICS_RANGE_DAYS).toEqual([1, 7, 14, 30]);
    expect(parseWebsiteAnalyticsRangeDays(undefined)).toBe(7);
    expect(parseWebsiteAnalyticsRangeDays(null)).toBe(7);
    for (const range of [1, 7, 14, 30]) {
      expect(parseWebsiteAnalyticsRangeDays(String(range))).toBe(range);
      expect(normalizeWebsiteAnalyticsRange(String(range))).toBe(range);
    }
    for (const invalid of ["0", "2", "29", "31", "7.0", "07", "all"] as const) {
      expect(parseWebsiteAnalyticsRangeDays(invalid)).toBeNull();
      expect(normalizeWebsiteAnalyticsRange(invalid)).toBe(7);
    }
  });

  it("builds inclusive Eastern windows and a previous equal comparison", () => {
    const now = DateTime.fromISO("2026-11-01T12:30:00", {
      zone: "America/New_York",
    });
    const window = buildWebsiteAnalyticsWindow(7, now);

    expect(window.timeframe).toMatchObject({
      timezone: "America/New_York",
      since: "2026-10-26",
      through: "2026-11-01",
      comparison: {
        kind: "previous_equal_period",
        since: "2026-10-19",
        through: "2026-10-25",
      },
    });
    expect(window.startAt.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(window.timeframe.generatedAt).toBe("2026-11-01T17:30:00.000Z");
  });

  it("builds canonical range, retry, and advertising-context URLs", () => {
    const advertising = normalizeAdvertisingContext({
      reportId: "report-1",
      campaignId: "campaign:2",
    });
    expect(websiteAnalyticsHref({ rangeDays: 14, advertising })).toBe(
      "/team/marketing/website?waRangeDays=14&gaReportId=report-1&gaCampaignId=campaign%3A2",
    );
    expect(
      websiteAnalyticsHref({
        rangeDays: 14,
        advertising,
        retryPanel: "vitals",
        retryToken: "2026-08-08T12:00:00.000Z",
        panel: "vitals",
      }),
    ).toBe(
      "/team/marketing/website?waRangeDays=14&gaReportId=report-1&gaCampaignId=campaign%3A2&waRetry=vitals&waRetryToken=2026-08-08T12%3A00%3A00.000Z#vitals",
    );
    expect(advertisingContextHref(advertising)).toBe(
      "/team/marketing/ads?gaReportId=report-1&gaCampaignId=campaign%3A2",
    );
    expect(
      normalizeAdvertisingContext({
        reportId: "<script>",
        campaignId: "x".repeat(121),
      }),
    ).toEqual({ reportId: null, campaignId: null });
  });

  it("keeps all four data sections independent and distinguishes empty from unavailable", () => {
    expect(
      SITE_COMPONENT.match(/loadAnalyticsResource<WebAnalytics/gu),
    ).toHaveLength(4);
    for (const panel of ["summary", "funnel", "errors", "vitals"] as const) {
      expect(SITE_COMPONENT).toContain(`id="${panel}"`);
      expect(SITE_COMPONENT).toContain(`panel="${panel}"`);
    }
    expect(SITE_COMPONENT).not.toContain("summary?.totals ??");
    expect(SITE_COMPONENT).toMatch(/No zero\s+values have been substituted\./u);
    expect(SITE_COMPONENT).toContain(
      "A displayed zero means the aggregate query",
    );
    expect(SITE_COMPONENT).toContain("Available · no page views");
    expect(SITE_COMPONENT).toContain("Available · no funnel events");
    expect(SITE_COMPONENT).toContain("Available · no failure events");
    expect(SITE_COMPONENT).toContain("Available · no eligible Vitals samples");
    expect(
      SITE_COMPONENT.match(/sm:hidden/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(
      SITE_COMPONENT.match(/hidden overflow-x-auto sm:block/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it("uses one strict range/timeframe contract in every reporting route", () => {
    for (const route of REPORT_ROUTES) {
      expect(route).toContain("parseWebsiteAnalyticsRangeDays(");
      expect(route).toContain("buildWebsiteAnalyticsWindow(rangeDays)");
      expect(route).toContain('error: "invalid_range"');
      expect(route).toContain("allowedRangeDays: WEBSITE_ANALYTICS_RANGE_DAYS");
      expect(route).toContain("{ status: 422 }");
      expect(route).toContain("timeframe,");
      expect(route).not.toContain("Math.min(Math.max");
    }
    expect(REPORT_ROUTES[3]).toContain(
      "('/','/book','/bookbrush','/bookdemo')",
    );
  });

  it("removes CRM and customer identifiers from first-party metadata", () => {
    const sanitized = sanitizeFirstPartyAnalyticsMeta({
      contactId: "4cc40c70-b35c-4b4d-9b6d-09dcc36d0fae",
      customer_id: "customer-123",
      threadId: "thread-123",
      messageId: "message-123",
      email: "customer@example.com",
      phone: "+1 (404) 555-1212",
      message: "private message contents",
      rating: "good",
      hasName: true,
      count: 2,
    });

    expect(sanitized).toEqual({ rating: "good", hasName: true, count: 2 });
    expect(isAnalyticsIdentifierKey("contact_id")).toBe(true);
    expect(isAnalyticsIdentifierKey("threadId")).toBe(true);
    expect(PUBLIC_INGEST).toContain("sanitizeFirstPartyAnalyticsMeta(");
  });

  it("allowlists only aggregate dimensions for the external provider", () => {
    expect(sanitizeAnalyticsProviderEventName("generate_lead")).toBe(
      "generate_lead",
    );
    expect(
      sanitizeAnalyticsProviderEventName("customer@example.com"),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProviderParams({
        source: "google",
        medium: "cpc",
        campaign: "spring-cleanup",
        service: "junk_removal",
        contactId: "contact-123",
        customerId: "customer-123",
        threadId: "thread-123",
        messageId: "message-123",
        appointment_id: "4cc40c70-b35c-4b4d-9b6d-09dcc36d0fae",
        email: "customer@example.com",
        phone: "4045551212",
      }),
    ).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "spring-cleanup",
      service: "junk_removal",
    });
    expect(
      sanitizeAnalyticsProviderParams({
        campaign: "4cc40c70-b35c-4b4d-9b6d-09dcc36d0fae",
      }),
    ).toEqual({});
    expect(GA_ADAPTER).toContain("sanitizeAnalyticsProviderParams(");
    expect(GA_ADAPTER).not.toContain("...payload.params");
    expect(GA_ADAPTER).not.toContain("user_id");
  });

  it("sends no record identifiers even when a caller supplies them", async () => {
    process.env["GA4_MEASUREMENT_ID"] = "G-TEST";
    process.env["GA4_API_SECRET"] = "test-secret";
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await sendConversion("generate_lead", {
      params: {
        source: "google",
        medium: "cpc",
        campaign: "spring-cleanup",
        service: "junk_removal",
        contactId: "contact-123",
        customerId: "customer-123",
        threadId: "thread-123",
        messageId: "message-123",
        appointment_id: "4cc40c70-b35c-4b4d-9b6d-09dcc36d0fae",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("Expected the analytics provider body to be JSON text");
    }
    const body = JSON.parse(init.body) as {
      client_id: string;
      events: Array<{ name: string; params: Record<string, unknown> }>;
    };
    expect(body.client_id).toBe("stonegate-public-web-aggregate");
    expect(body.events).toEqual([
      {
        name: "generate_lead",
        params: {
          engagement_time_msec: 1,
          source: "google",
          medium: "cpc",
          campaign: "spring-cleanup",
          service: "junk_removal",
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /contact-123|customer-123|thread-123|message-123|4cc40c70/iu,
    );
  });
});
