import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPartnerBookingScope,
  clampPartnerAddOnQuantity,
  serializePartnerAddOnQuantities,
} from "./partner-booking-add-ons";

test("serializes only canonical quantity add-ons and never accepts client prices", () => {
  const selections = serializePartnerAddOnQuantities({
    tire_disposal: 3,
    mattress_disposal: 2,
    "invalid key": 4,
    paint_can_disposal: 101,
  });

  assert.deepEqual(selections, [
    { key: "mattress_disposal", quantity: 2 },
    { key: "tire_disposal", quantity: 3 },
  ]);
  assert.equal("unitAmountMinor" in selections[0]!, false);
});

test("clamps quantity input to the configured service option", () => {
  assert.equal(
    clampPartnerAddOnQuantity({ value: 0, minimum: 2, maximum: 10 }),
    2,
  );
  assert.equal(
    clampPartnerAddOnQuantity({ value: 50, minimum: 2, maximum: 10 }),
    10,
  );
  assert.equal(
    clampPartnerAddOnQuantity({ value: Number.NaN, minimum: 2, maximum: 10 }),
    2,
  );
});

test("persists explicit restricted and non-standard disclosures into review scope", () => {
  assert.deepEqual(
    buildPartnerBookingScope({
      itemCount: "12",
      volumeCubicYards: "4.5",
      restrictedItems: true,
      nonStandard: true,
    }),
    {
      itemCount: 12,
      volumeCubicYards: 4.5,
      restrictedItems: true,
      nonStandard: true,
    },
  );
  assert.deepEqual(
    buildPartnerBookingScope({
      itemCount: "not-a-number",
      volumeCubicYards: "",
      restrictedItems: false,
      nonStandard: false,
    }),
    {},
  );
});
