import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPartnerBookingScope,
  clampPartnerAddOnQuantity,
  serializePartnerAddOnQuantities,
} from "./partner-booking-add-ons";

void test("serializes only canonical quantity add-ons and never accepts client prices", () => {
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

void test("clamps quantity input to the configured service option", () => {
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

void test("persists explicit restricted and non-standard disclosures into review scope", () => {
  assert.deepEqual(
    buildPartnerBookingScope({
      itemCount: "12",
      volumeCubicYards: "4.5",
      restrictedItems: true,
      nonStandard: true,
      hazardCategories: ["paint", "chemicals", "paint", "forged"],
      equipmentNeeds: ["heavy_lift", "stairs"],
      requiredCompletionDate: "2026-09-18",
      requiredCompletionTime: "14:30",
      multiStop: true,
      multiStopDetails: "Pickup at building A, then finish at building B.",
      alternateContactName: "Site supervisor",
      alternateContactPhone: "+14785550199",
    }),
    {
      itemCount: 12,
      volumeCubicYards: 4.5,
      restrictedItems: true,
      hazardCategories: ["chemicals", "paint"],
      nonStandard: true,
      equipmentNeeds: ["heavy_lift", "stairs"],
      requiredCompletion: {
        localDate: "2026-09-18",
        localTime: "14:30",
      },
      multiStop: true,
      multiStopDetails: "Pickup at building A, then finish at building B.",
      alternateContact: {
        name: "Site supervisor",
        phone: "+14785550199",
        email: "",
      },
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
