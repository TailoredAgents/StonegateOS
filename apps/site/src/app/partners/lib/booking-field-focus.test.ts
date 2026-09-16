import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingErrorSection,
  bookingFieldElementId,
  focusBookingField,
} from "./booking-field-focus";

void test("server scope, contact, billing and proof errors resolve to the correct section and field", () => {
  const cases = [
    ["scope.alternateContact", "contact", "partner-book-alternate-name"],
    ["scope.alternateContact.phone", "contact", "partner-book-alternate-phone"],
    ["scope.alternateContact.email", "contact", "partner-book-alternate-email"],
    ["commercial.billingContact", "commercial", "partner-book-billing-name"],
    [
      "commercial.billingContact.email",
      "commercial",
      "partner-book-billing-email",
    ],
    ["billingContact", "commercial", "partner-book-billing-name"],
    ["commercial.poNumber", "commercial", "partner-book-po"],
    ["scope.volumeCubicYards", "scope", "partner-book-volume"],
    [
      "scope.requiredCompletion.localTime",
      "scope",
      "partner-book-required-time",
    ],
    ["scope.multiStopDetails", "scope", "partner-book-multi-stop-details"],
    ["scope.hazardCategories", "scope", "partner-book-materials"],
    ["scope.hazardCategories[0]", "scope", "partner-book-materials"],
    ["scope.equipmentNeeds.0", "scope", "partner-book-equipment"],
    ["scope.nonStandard", "scope", "partner-book-non-standard"],
    ["scope.restrictedItems", "scope", "partner-book-restricted-items"],
    ["scope.multiStop", "scope", "partner-book-multi-stop"],
    ["scope.customRequiredField", "scope", "partner-book-scope"],
    ["selectedAddOns.0.quantity", "addons", "partner-book-add-ons"],
    ["proofRequirements", "proof", "partner-book-proof"],
    ["onSiteContact.email", "contact", "partner-book-contact-email"],
    ["contactMethod", "contact", "partner-book-contact-phone"],
    ["accessDetails", "contact", "partner-book-access"],
    ["crewInstructions", "contact", "partner-book-crew-instructions"],
    [
      "preferredWindows[1].localDate",
      "scheduling",
      "partner-book-preferred-date-2",
    ],
    ["locationId", "address", "partner-book-location"],
    ["tierKey", "service", "partner-book-base-option"],
    ["serviceKey", "service", "partner-book-service"],
  ] as const;
  for (const [field, section, id] of cases) {
    assert.equal(bookingErrorSection(field), section, field);
    assert.equal(bookingFieldElementId(field), id, field);
  }
  assert.equal(
    bookingFieldElementId("unexpected[server]field"),
    "partner-book-description",
  );
  assert.equal(bookingFieldElementId("__proto__"), "partner-book-description");
});

void test("focus opens every enclosing disclosure before focusing, retaining other open sections", () => {
  const outer = { tagName: "DETAILS", open: false, parentElement: null };
  const inner = { tagName: "DETAILS", open: false, parentElement: outer };
  const other = { tagName: "DETAILS", open: true, parentElement: null };
  let focused = false;
  const target = {
    tagName: "INPUT",
    parentElement: inner,
    focus() {
      assert.equal(inner.open, true);
      assert.equal(outer.open, true);
      assert.equal(other.open, true);
      focused = true;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) =>
          id === "partner-book-alternate-email" ? target : null,
      },
    });
    assert.equal(focusBookingField("scope.alternateContact.email"), true);
    assert.equal(focused, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("an unavailable conditional scope field falls back to its section without throwing", () => {
  let focused = false;
  const section = {
    tagName: "FIELDSET",
    parentElement: null,
    focus: () => {
      focused = true;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) =>
          id === "partner-book-scope" ? section : null,
      },
    });
    assert.equal(focusBookingField("scope.multiStopDetails"), true);
    assert.equal(focused, true);
    assert.equal(focusBookingField("locationId"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("focus is safe during server rendering without a document", () => {
  assert.equal(typeof document, "undefined");
  assert.equal(focusBookingField("proofRequirements"), false);
});
