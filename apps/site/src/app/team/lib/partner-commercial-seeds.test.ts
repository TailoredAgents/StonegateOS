import assert from "node:assert/strict";
import test from "node:test";
import {
  newPartnerQuoteComposerDraft,
  parsePartnerQuoteServiceSeeds,
  calculateQuoteV2OptimisticTotals,
  type PartnerQuoteServiceSeed,
} from "./quote-v2-composer-model";
import { partnerInvoiceRowsForJob } from "./partner-invoice-lines";

const lines: PartnerQuoteServiceSeed[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    serviceKey: "painting",
    title: "Painting",
    description: "Paint the interior lobby.\nKeep the stone wall untouched.",
    amountCents: 12345,
    rateReferences: ["Interior walls: $0.1255 / square foot"],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    serviceKey: "soft-washing",
    title: "Soft washing",
    description: "Wash the roof.",
    amountCents: null,
    rateReferences: [],
  },
];
void test("fresh partner quote retains all work and exact reviewed amounts without invented hauloff or unpriced zero", () => {
  const draft = newPartnerQuoteComposerDraft("new-quote", lines);
  assert.equal(draft.audience, "commercial");
  assert.equal(draft.schedulingMode, "staff_followup");
  assert.deepEqual(
    draft.lines.map((line) => [
      line.name,
      line.description,
      line.unitPriceMin,
      line.unitPriceMax,
    ]),
    [
      ["Painting", lines[0]!.description, "123.45", "123.45"],
      ["Soft washing", "Wash the roof.", "", ""],
    ],
  );
  assert.equal(draft.inclusions, "");
  assert.equal(draft.durationMinutes, "");
  assert.match(draft.scope, /stone wall untouched/);
  assert.equal(calculateQuoteV2OptimisticTotals(draft).valid, false);
  draft.lines[0]!.description = "Staff edited scope";
  assert.equal(lines[0]!.description.includes("stone wall"), true);
});
void test("commercial seed parser rejects missing or malformed amounts instead of treating them as zero", () => {
  assert.deepEqual(parsePartnerQuoteServiceSeeds(lines), lines);
  assert.equal(
    parsePartnerQuoteServiceSeeds([{ ...lines[0], amountCents: "12345" }]),
    null,
  );
  assert.equal(
    parsePartnerQuoteServiceSeeds([{ ...lines[0], amountCents: undefined }]),
    null,
  );
  assert.equal(parsePartnerQuoteServiceSeeds([lines[0], lines[0]]), null);
  assert.equal(parsePartnerQuoteServiceSeeds({}), null);
});
void test("invoice seed itemizes the parent and preserves legacy totals without inventing service prices", () => {
  const seeded = partnerInvoiceRowsForJob({
    id: "parent",
    service: null,
    totalCents: null,
    serviceLines: lines,
  });
  assert.deepEqual(
    seeded.map((line) => line.unitAmountCents),
    [12345, null],
  );
  assert.match(seeded[0]!.description, /^Painting\n/);
  assert.equal(
    partnerInvoiceRowsForJob({
      id: "legacy",
      service: "Existing agreed service",
      totalCents: 9999,
    })[0]!.unitAmountCents,
    9999,
  );
  assert.equal(
    partnerInvoiceRowsForJob({
      id: "parent",
      service: null,
      totalCents: 500,
      serviceLines: [{ ...lines[0]!, description: "long ".repeat(500) }],
    })[0]!.description,
    "Painting",
  );
});
