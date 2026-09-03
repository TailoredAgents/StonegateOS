import fs from "node:fs";
import path from "node:path";
import {
  normalizePartnerProductEvent,
  PARTNER_WEB_VITAL_METRICS,
  parsePartnerFunnelKey,
  sanitizePartnerAnalyticsPath,
} from "@/lib/partner-product-analytics";

describe("Partner product analytics privacy contract", () => {
  test("accepts only stable funnel stage/persona dimensions", () => {
    expect(
      normalizePartnerProductEvent({
        event: "partner_funnel",
        path: "/partners/book?po=private",
        key: "availability_slot_full:property_manager",
        meta: {
          surface: "booking",
          step: 4,
          address: "never stored",
          filename: "private.jpg",
        },
      }),
    ).toEqual({
      event: "partner_funnel",
      path: "/partners/book",
      key: "availability_slot_full:property_manager",
      meta: { surface: "booking", step: 4 },
    });
    expect(parsePartnerFunnelKey("unknown_stage:contractor")).toBeNull();
    expect(
      parsePartnerFunnelKey("booking_started:user@example.com"),
    ).toBeNull();
  });

  test("accepts the bounded landing-to-access funnel dimensions", () => {
    expect(
      normalizePartnerProductEvent({
        event: "partner_funnel",
        path: "/partners/request-access?email=private@example.com",
        key: "verification_request_accepted:unknown",
        meta: {
          surface: "access",
          email: "private@example.com",
        },
      }),
    ).toEqual({
      event: "partner_funnel",
      path: "/partners/request-access",
      key: "verification_request_accepted:unknown",
      meta: { surface: "access" },
    });
    expect(
      normalizePartnerProductEvent({
        event: "partner_funnel",
        path: "/partners/book",
        key: "verification_request_accepted:unknown",
        meta: { surface: "booking" },
      }),
    ).toBeNull();
    expect(
      normalizePartnerProductEvent({
        event: "partner_funnel",
        path: "/partners/request-access",
        key: "booking_started:unknown",
        meta: { surface: "access" },
      }),
    ).toBeNull();
  });

  test("normalizes only LCP, INP, and CLS with server-derived ratings", () => {
    expect(PARTNER_WEB_VITAL_METRICS).toEqual(["LCP", "INP", "CLS"]);
    expect(
      normalizePartnerProductEvent({
        event: "web_vital",
        path: "/partners?account=private",
        key: "lcp",
        value: 2_500.4,
        meta: { rating: "poor", address: "never stored" },
      }),
    ).toEqual({
      event: "web_vital",
      path: "/partners",
      key: "LCP",
      value: 2_500,
      meta: { rating: "good" },
    });
    expect(
      normalizePartnerProductEvent({
        event: "web_vital",
        path: "/partners",
        key: "LCP",
        value: 2_500.5,
      }),
    ).toEqual(
      expect.objectContaining({
        value: 2_501,
        meta: { rating: "needs_improvement" },
      }),
    );
    expect(
      normalizePartnerProductEvent({
        event: "web_vital",
        path: "/partners/overview",
        key: "INP",
        value: 500,
      }),
    ).toEqual(
      expect.objectContaining({
        key: "INP",
        value: 500,
        meta: { rating: "needs_improvement" },
      }),
    );
    expect(
      normalizePartnerProductEvent({
        event: "web_vital",
        path: "/partners",
        key: "CLS",
        value: 0.25004,
      }),
    ).toEqual(
      expect.objectContaining({
        key: "CLS",
        value: 0.25,
        meta: { rating: "needs_improvement" },
      }),
    );
  });

  test("rejects unsupported or unsafe Partner web-vital values", () => {
    expect(
      normalizePartnerProductEvent({
        event: "web_vital",
        path: "/",
        key: "LCP",
        value: 1_000,
      }),
    ).toBeNull();
    for (const input of [
      { key: "FCP", value: 1_000 },
      { key: "INP", value: -1 },
      { key: "INP", value: 120_001 },
      { key: "CLS", value: 10.0001 },
      { key: "CLS", value: Number.NaN },
      { key: "CLS", value: Number.POSITIVE_INFINITY },
      { key: "CLS", value: undefined },
    ]) {
      expect(
        normalizePartnerProductEvent({
          event: "web_vital",
          path: "/partners",
          ...input,
        }),
      ).toBeNull();
    }
    for (const { key, value } of [
      { key: "LCP", value: 0 },
      { key: "LCP", value: 120_000 },
      { key: "INP", value: 0 },
      { key: "INP", value: 120_000 },
      { key: "CLS", value: 0 },
      { key: "CLS", value: 10 },
    ]) {
      expect(
        normalizePartnerProductEvent({
          event: "web_vital",
          path: "/partners",
          key,
          value,
        }),
      ).toEqual(expect.objectContaining({ key, value }));
    }
  });

  test("rejects values attached to non-vital Partner events", () => {
    expect(
      normalizePartnerProductEvent({
        event: "partner_action",
        path: "/partners/request-access",
        key: "access_email_submit",
        value: 1,
      }),
    ).toBeNull();
  });

  test("scrubs job/share tokens and rejects arbitrary partner events", () => {
    expect(
      sanitizePartnerAnalyticsPath(
        "/partners/bookings/108b85dd-d34e-4e00-a842-6257ab8589aa",
      ),
    ).toBe("/partners/bookings/[job]");
    expect(
      sanitizePartnerAnalyticsPath(
        "/partners/properties/1-private-street-person-example-com",
      ),
    ).toBe("/partners/properties/[other]");
    expect(
      normalizePartnerProductEvent({
        event: "partner_contact_email",
        path: "/partners/settings",
        key: "person@example.com",
      }),
    ).toBeNull();
  });

  test("generic partner actions discard arbitrary metadata", () => {
    expect(
      normalizePartnerProductEvent({
        event: "partner_action",
        path: "/partners/overview",
        key: "schedule_job",
        meta: { notes: "private" },
      }),
    ).toEqual({
      event: "partner_action",
      path: "/partners/overview",
      key: "schedule_job",
      meta: {},
    });
  });

  test("rejects oversized dimensions and bounds every retained path segment", () => {
    expect(
      normalizePartnerProductEvent({
        event: "partner_action",
        path: `/partners/${"location-name".repeat(100)}?address=private`,
        key: "x".repeat(65),
        meta: { notes: "private" },
      }),
    ).toBeNull();
    const sanitized = sanitizePartnerAnalyticsPath(
      `/partners/${"location-name".repeat(100)}?address=private`,
    );
    expect(sanitized).not.toContain("address");
    expect(sanitized).not.toContain("location-name");
    expect(sanitized.split("/").at(-1)?.length ?? 0).toBeLessThanOrEqual(64);
  });

  test("public ingestion enforces Partner privacy on the server", () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), "app/api/public/web-events/route.ts"),
      "utf8",
    );
    expect(route).toContain("isPartnerAnalyticsSurface(");
    expect(route).toContain("normalizePartnerProductEvent({");
    expect(route).toContain("value: evt.value");
    expect(route).toContain("pseudonymizePartnerAnalyticsId(");
    expect(route).toMatch(/protectsPartnerData\s*\?\s*null/u);
    expect(route).toContain("!protectsPartnerData && evt.zip");
    expect(route).toMatch(/if \(normalizedZip\) \{\s+const policy/u);
    expect(route).toContain("if (protectsPartnerData && !partnerProductEvent)");
    expect(route).toContain("const RETAIN_DAYS = 30");
    expect(route).toContain("db.delete(webEvents)");
    expect(route).toContain("db.delete(webVitals)");
  });
});
