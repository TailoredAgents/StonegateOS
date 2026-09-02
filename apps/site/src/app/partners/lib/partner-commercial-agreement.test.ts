import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePartnerServiceRateCard } from "./partner-service-rate-card";

function siteSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function payload(currency = "USD") {
  return {
    agreement: {
      label: "2026 property portfolio agreement",
      currency,
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2027-01-01T00:00:00.000Z",
      inclusions: ["One scheduled load"],
      exclusions: ["Hazardous material"],
      quoteRules: "Scope discrepancies require a revised written quote.",
      services: [
        {
          serviceKey: "junk-removal",
          pricingState: "contracted",
          inclusions: ["Standard debris"],
          exclusions: ["Paint"],
          quoteRule: "Call for loads above the contracted tier.",
        },
      ],
      document: {
        id: "11111111-1111-4111-8111-111111111111",
        filename: "2026-service-agreement.pdf",
      },
    },
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
        addOns: [],
      },
    ],
  };
}

void test("billing parses bounded effective agreement and entitlement terms", () => {
  const parsed = parsePartnerServiceRateCard(payload());
  assert.equal(parsed.status, "ready");
  if (parsed.status !== "ready") return;
  assert.deepEqual(parsed.agreement, payload().agreement);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.items[0]?.amountCents, 25_000);
});

void test("billing fails closed when rate and agreement currencies disagree", () => {
  assert.deepEqual(parsePartnerServiceRateCard(payload("CAD")), {
    status: "error",
  });
});

void test("billing fails closed on malformed or unbounded agreement evidence", () => {
  const malformed = payload();
  malformed.agreement.inclusions = Array.from(
    { length: 41 },
    (_, index) => `Inclusion ${index}`,
  );
  assert.deepEqual(parsePartnerServiceRateCard(malformed), {
    status: "error",
  });
});

void test("Partner booking and billing disclose finality, agreement terms, and discrepancy handling", () => {
  const booking = siteSource("../components/PartnerBookingWizard.tsx");
  const billing = siteSource("../(portal)/billing/page.tsx");
  const job = siteSource("../(portal)/bookings/[jobId]/page.tsx");
  for (const copy of [
    "Current account agreement",
    "Included",
    "Excluded",
    "quote",
  ]) {
    assert.match(booking, new RegExp(copy, "u"));
  }
  assert.match(billing, /Service agreement & rates/u);
  assert.match(billing, /Active account terms/u);
  assert.match(
    billing,
    /Material\s+scope\s+discrepancies\s+require\s+an\s+explicit\s+revised\s+quote\s+or\s+change\s+order/u,
  );
  assert.match(billing, /Find the secure copy in Documents below/u);
  assert.match(job, /notificationDestination/u);
  assert.match(job, /Notification settings/u);
  assert.match(job, /operationalEffectsPending/u);
});

void test("Staff agreement control is explicit, bounded, and accessible", () => {
  const manager = siteSource(
    "../../team/components/PartnerServiceAgreementManager.tsx",
  );
  const action = siteSource("../../team/actions/partner-administration.ts");
  assert.match(manager, /aria-labelledby="service-agreement-heading"/u);
  assert.match(manager, /Service entitlements/u);
  assert.match(manager, /Contracted final rate/u);
  assert.match(manager, /Quote required/u);
  assert.match(manager, /one item per line/iu);
  assert.match(manager, /UPDATE SERVICE AGREEMENT/u);
  assert.match(action, /partners\.commercial\.manage/u);
  assert.match(action, /Idempotency/u);
  assert.match(action, /expectedVersion/u);
});
