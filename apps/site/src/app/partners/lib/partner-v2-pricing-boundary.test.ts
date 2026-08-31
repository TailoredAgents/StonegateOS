import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePartnerServiceRateCard } from "./partner-service-rate-card";

function partnerPage(relativePath: string): string {
  return readFileSync(new URL(`../(portal)/${relativePath}`, import.meta.url), {
    encoding: "utf8",
  });
}

void test("protected booking uses only the selected-account V2 service catalog", () => {
  const source = partnerPage("book/page.tsx");
  assert.match(source, /\/api\/portal\/v2\/service-catalog/u);
  assert.doesNotMatch(source, /\/api\/portal\/rates/u);
  assert.doesNotMatch(source, /mergeServices\s*\(/u);
});

void test("protected billing never falls back to contact-scoped legacy rates", () => {
  const source = partnerPage("billing/page.tsx");
  assert.match(source, /\/api\/portal\/v2\/service-catalog/u);
  assert.doesNotMatch(source, /\/api\/portal\/rates/u);
  assert.match(source, /parsePartnerServiceRateCard/u);
});

void test("V2 catalog prices become public-key rate rows without internal IDs", () => {
  assert.deepEqual(
    parsePartnerServiceRateCard({
      services: [
        {
          key: "junk-removal",
          label: "Junk removal",
          pricingStatus: "contracted",
          baseOptions: [
            {
              tierKey: "half",
              label: "Half load",
              pricingStatus: "contracted",
              price: { amountMinor: 25_000, currency: "USD", minorUnit: 2 },
            },
          ],
          addOns: [
            {
              key: "mattress_disposal",
              label: "Mattress disposal",
              unitLabel: "mattress",
              pricingStatus: "contracted",
              unitPrice: {
                amountMinor: 3_000,
                currency: "USD",
                minorUnit: 2,
              },
            },
          ],
        },
      ],
    }),
    {
      status: "ready",
      currency: "USD",
      items: [
        {
          id: "junk-removal:base:half",
          serviceKey: "junk-removal",
          serviceLabel: "Junk removal",
          tierKey: "half",
          label: "Half load",
          amountCents: 25_000,
          sortOrder: 0,
        },
        {
          id: "junk-removal:add-on:mattress_disposal",
          serviceKey: "junk-removal",
          serviceLabel: "Junk removal",
          tierKey: "mattress_disposal",
          label: "Mattress disposal (per mattress)",
          amountCents: 3_000,
          sortOrder: 500,
        },
      ],
    },
  );
});

void test("limited-access hidden prices stay hidden on direct billing loads", () => {
  assert.deepEqual(
    parsePartnerServiceRateCard({
      services: [
        {
          key: "junk-removal",
          label: "Junk removal",
          pricingStatus: "hidden",
          baseOptions: [
            {
              tierKey: "half",
              label: "Half load",
              pricingStatus: "hidden",
              price: null,
            },
          ],
          addOns: [],
        },
      ],
    }),
    { status: "forbidden" },
  );
});
