import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatOpenAiAdsReportCount,
  formatOpenAiAdsReportMoney,
  parseOpenAiAdsCampaignReport,
  type OpenAiAdsCampaignReport,
} from "../src/app/team/lib/openai-ads-reporting-model";
import { OpenAiAdsCampaignReportView } from "../src/app/team/components/OpenAiAdsCampaignReportView";

function report(): OpenAiAdsCampaignReport {
  const metrics = {
    spend: 123.45,
    impressions: 1000,
    clicks: 25,
    attributedConversions: 3,
    bookingConversions: null,
    phoneInquiryConversions: null,
    costPerConversion: 41.15,
  };
  return {
    ok: true,
    configured: true,
    account: {
      id: "account-1",
      name: "Stonegate",
      currency: "USD",
      timeZone: "America/Los_Angeles",
    },
    timeframe: {
      since: "2026-09-09",
      through: "2026-09-15",
      timezone: "America/New_York",
      generatedAt: "2026-09-15T18:00:00Z",
    },
    fetchedAt: "2026-09-15T18:00:00Z",
    totals: metrics,
    campaigns: [
      { id: "campaign-1", name: "Bookings", status: "active", ...metrics },
    ],
    conversionBreakdownAvailable: false,
  };
}

void test("report parser rejects incomplete metrics and provider errors instead of filling in zeroes", () => {
  assert.ok(parseOpenAiAdsCampaignReport(report()));
  assert.equal(
    parseOpenAiAdsCampaignReport({ ok: false, error: "provider_failed" }),
    null,
  );
  assert.equal(parseOpenAiAdsCampaignReport({ ...report(), totals: {} }), null);
  assert.equal(
    parseOpenAiAdsCampaignReport({
      ...report(),
      totals: { ...report().totals, spend: "unknown" },
    }),
    null,
  );
  assert.equal(
    parseOpenAiAdsCampaignReport({
      ...report(),
      totals: { ...report().totals, clicks: -1 },
    }),
    null,
  );
});

void test("missing attribution stays unavailable and reported zero remains zero", () => {
  assert.equal(formatOpenAiAdsReportCount(null), "Unavailable");
  assert.equal(formatOpenAiAdsReportCount(0), "0");
  const value = report();
  value.totals.attributedConversions = null;
  const parsed = parseOpenAiAdsCampaignReport(value);
  assert.equal(parsed?.totals.attributedConversions, null);
  assert.equal(parsed?.totals.bookingConversions, null);
});

void test("reported spend uses major units and the account currency", () => {
  assert.equal(formatOpenAiAdsReportMoney(123.45, "USD"), "$123.45");
  assert.equal(formatOpenAiAdsReportMoney(125, "JPY"), "¥125");
  assert.equal(formatOpenAiAdsReportMoney(null, "USD"), "Unavailable");
});

void test("campaign report presents the actual account, reporting period, timezone and freshness", () => {
  const html = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: report() },
      refreshHref: "/team?waRangeDays=7&waRetryToken=refresh#chatgpt-campaigns",
    }),
  );
  assert.match(html, /Stonegate/);
  assert.match(html, /\$123\.45/);
  assert.match(html, /1,000/);
  assert.match(html, /Sep 9, 2026/);
  assert.match(html, /Sep 15, 2026/);
  assert.match(html, /Report timezone: America\/New_York/);
  assert.match(html, /Account timezone: America\/Los_Angeles/);
  assert.match(html, /Fetched Sep 15, 2:00 PM EDT/);
  assert.match(html, /ChatGPT reports these outcomes together/);
  assert.match(html, /Attributed bookings: [\s\S]*?Unavailable/);
  assert.match(html, /Attributed phone inquiries: [\s\S]*?Unavailable/);
  assert.match(html, /click-through conversion events/);
  assert.doesNotMatch(html, /ROAS|unique customers/);
});

void test("empty confirmed report and failed report have distinct UI states", () => {
  const empty = report();
  empty.campaigns = [];
  empty.totals = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    attributedConversions: 0,
    bookingConversions: null,
    phoneInquiryConversions: null,
    costPerConversion: null,
  };
  const emptyHtml = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: empty },
      refreshHref: "/team",
    }),
  );
  assert.match(emptyHtml, /No ad activity was reported/);
  assert.match(emptyHtml, /\$0\.00/);
  for (const kind of ["unavailable", "not_configured", "forbidden"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(OpenAiAdsCampaignReportView, {
        state: { kind },
        refreshHref: "/team",
      }),
    );
    assert.doesNotMatch(html, /\$0\.00|No ad activity was reported|<table/);
    assert.match(html, /Refresh report/);
  }
});

void test("an unsupported breakdown cannot display plausible fabricated subtype numbers", () => {
  const value = report();
  value.totals.bookingConversions = 100;
  value.totals.phoneInquiryConversions = 200;
  const html = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: value },
      refreshHref: "/team",
    }),
  );
  assert.doesNotMatch(html, />100<|>200</);
  assert.match(html, /separate booking and phone totals are unavailable/);
});

void test("a valid empty provider page preserves unavailable totals without claiming zero activity", () => {
  const value = report();
  value.campaigns = [];
  value.totals = {
    spend: null,
    impressions: null,
    clicks: null,
    attributedConversions: null,
    bookingConversions: null,
    phoneInquiryConversions: null,
    costPerConversion: null,
  };
  assert.ok(parseOpenAiAdsCampaignReport(value));
  const html = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: value },
      refreshHref: "/team",
    }),
  );
  assert.match(html, /Some performance totals are unavailable/);
  assert.doesNotMatch(html, /No ad activity was reported|\$0\.00/);
});

void test("cost per conversion uses the provider value and is unavailable when no conversions are reported", () => {
  const value = report();
  value.totals.costPerConversion = 40.5;
  const html = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: value },
      refreshHref: "/team",
    }),
  );
  assert.match(html, /Cost per conversion/);
  assert.match(html, /\$40\.50/);
  value.totals.attributedConversions = 0;
  const zeroHtml = renderToStaticMarkup(
    React.createElement(OpenAiAdsCampaignReportView, {
      state: { kind: "ready", report: value },
      refreshHref: "/team",
    }),
  );
  assert.doesNotMatch(zeroHtml, /\$40\.50/);
});
