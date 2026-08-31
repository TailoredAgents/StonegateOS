import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePartnerAnalyticsPath } from "./PartnerProductAnalyticsClient";

void test("partner analytics removes query strings and opaque identifiers", () => {
  assert.equal(
    sanitizePartnerAnalyticsPath(
      "/partners/bookings/108b85dd-d34e-4e00-a842-6257ab8589aa?po=secret",
    ),
    "/partners/bookings/[job]",
  );
  assert.equal(
    sanitizePartnerAnalyticsPath(
      "/partners/proof/abcdefghijklmnopqrstuvwxyz0123456789",
    ),
    "/partners/proof/[share]",
  );
});

void test("partner analytics refuses non-partner paths", () => {
  assert.equal(
    sanitizePartnerAnalyticsPath("/team/contacts/private"),
    "/partners",
  );
});
