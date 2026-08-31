import assert from "node:assert/strict";
import test from "node:test";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import {
  areCanonicalQuoteServicesActionable,
  deriveCanonicalQuoteServices,
  QUOTE_SERVICE_KEYWORDS,
} from "../src/app/api/chat/quote-action-services";

void test("chat normalization covers every non-custom pricing preset", () => {
  const presetIds = serviceRates
    .map((service) => service.service)
    .filter((service) => service !== "other")
    .sort();
  const resolverIds = QUOTE_SERVICE_KEYWORDS.map((entry) => entry.id).sort();

  assert.deepEqual(resolverIds, presetIds);
  for (const id of presetIds) {
    assert.deepEqual(deriveCanonicalQuoteServices("Create a quote", [id]), [
      id,
    ]);
  }
});

void test("classifier prose is normalized to catalog-backed quote service IDs", () => {
  assert.deepEqual(
    deriveCanonicalQuoteServices("Quote a sofa pickup", [
      "furniture removal",
      "invented surcharge",
    ]),
    ["furniture"],
  );
});

void test("unknown classifier hints never become quote service IDs", () => {
  assert.deepEqual(
    deriveCanonicalQuoteServices("Create an estimate", [
      "concierge magic",
      "other",
    ]),
    [],
  );
});

void test("known service IDs, aliases, and message matches are deduplicated", () => {
  assert.deepEqual(
    deriveCanonicalQuoteServices("Bid the hot tub and old fridge", [
      "hot-tub",
      "appliance hauling",
    ]),
    ["hot-tub", "appliances"],
  );
});

void test("generic junk removal is not mispriced as construction debris", () => {
  assert.deepEqual(
    deriveCanonicalQuoteServices("Create a junk removal quote", [
      "junk-removal",
    ]),
    ["junk-removal"],
  );
  assert.equal(areCanonicalQuoteServicesActionable(["junk-removal"]), false);
  assert.deepEqual(
    deriveCanonicalQuoteServices("Create a junk removal quote for a sofa", [
      "junk-removal",
    ]),
    ["furniture"],
  );
  assert.equal(areCanonicalQuoteServicesActionable(["furniture"]), true);
});

void test("house wash and yard-waste aliases resolve without accepting custom other", () => {
  assert.deepEqual(deriveCanonicalQuoteServices("Estimate a soft wash"), [
    "house-wash",
  ]);
  assert.deepEqual(deriveCanonicalQuoteServices("Quote brush and branches"), [
    "yard-waste",
  ]);
  assert.deepEqual(deriveCanonicalQuoteServices("Create quote", ["other"]), []);
});
