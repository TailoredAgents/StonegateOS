import assert from "node:assert/strict";
import test from "node:test";
import { normalizePartnerReturnTo, partnerLoginHref } from "./safe-return";

void test("partner login defaults to the protected overview", () => {
  assert.equal(normalizePartnerReturnTo(undefined), "/partners/overview");
  assert.equal(partnerLoginHref(undefined), "/partners/login");
});

void test("protected deep links are preserved", () => {
  const target = "/partners/bookings/job-123?tab=proof";
  assert.equal(normalizePartnerReturnTo(target), target);
  assert.equal(
    partnerLoginHref(target),
    `/partners/login?returnTo=${encodeURIComponent(target)}`,
  );
});

void test("public, token, and external destinations cannot become login returns", () => {
  for (const candidate of [
    "https://attacker.test/partners/overview",
    "//attacker.test/partners/overview",
    "/partners",
    "/partners/activate?token=secret",
    "/partners/application",
    "/partners/forgot-password",
    "/partners/reset-password?token=secret",
    "/partners/verify?token=secret",
    "/partners/not-a-real-protected-route",
  ]) {
    assert.equal(normalizePartnerReturnTo(candidate), "/partners/overview");
  }
});
