import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePartnerFunnelPersona,
  partnerFunnelKey,
  PARTNER_FUNNEL_PERSONAS,
  PARTNER_FUNNEL_STAGES,
} from "./product-analytics";

void test("funnel stages and personas remain stable, bounded dimensions", () => {
  assert.deepEqual(PARTNER_FUNNEL_PERSONAS, [
    "contractor",
    "real_estate_agent",
    "property_manager",
    "commercial_client",
    "other",
    "unknown",
  ]);
  assert.ok(PARTNER_FUNNEL_STAGES.includes("availability_slot_full"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("booking_abandoned"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("upload_interrupted"));
});

void test("unknown or attacker-controlled persona input collapses safely", () => {
  assert.equal(normalizePartnerFunnelPersona(" Contractor "), "contractor");
  assert.equal(normalizePartnerFunnelPersona("person@example.com"), "unknown");
  assert.equal(
    partnerFunnelKey("booking_started", "property_manager"),
    "booking_started:property_manager",
  );
});
