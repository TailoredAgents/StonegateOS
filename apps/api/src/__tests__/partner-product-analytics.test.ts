import fs from "node:fs";
import path from "node:path";
import {
  normalizePartnerProductEvent,
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
