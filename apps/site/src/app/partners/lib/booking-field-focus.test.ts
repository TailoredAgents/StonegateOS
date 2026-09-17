import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingErrorSection,
  bookingFieldElementId,
  bookingFieldStep,
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
      "scheduling",
      "partner-book-required-time",
    ],
    ["scope.multiStopDetails", "address", "partner-book-multi-stop-details"],
    ["scope.hazardCategories", "scope", "partner-book-materials"],
    ["scope.hazardCategories[0]", "scope", "partner-book-materials"],
    ["scope.equipmentNeeds.0", "contact", "partner-book-equipment"],
    ["scope.nonStandard", "scope", "partner-book-non-standard"],
    ["scope.restrictedItems", "scope", "partner-book-restricted-items"],
    ["scope.multiStop", "address", "partner-book-multi-stop"],
    ["scope.customRequiredField", "scope", "partner-book-work-questions"],
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

void test("moved fields and nested server paths return to their owning wizard step", () => {
  const cases = [
    ["locationId", 0],
    ["scope.multiStop", 0],
    ["scope.multiStopDetails", 0],
    ["scope.multiStopDetails.custom", 0],
    ["scope.requiredCompletion", 2],
    ["scope.requiredCompletion.localDate", 2],
    ["scope.requiredCompletion.localTime", 2],
    ["scope.requiredCompletion.custom", 2],
    ["preferredWindows[1].localDate", 2],
    ["scope", 1],
    ["scope.equipmentNeeds[2]", 1],
    ["scope.hazardCategories[0]", 1],
    ["scope.itemCount", 1],
    ["scope.alternateContact.phone", 1],
    ["commercial.billingContact.email", 1],
    ["scope.multiStopDetailsUnexpected", 1],
    ["scope.requiredCompletionUnexpected", 1],
    ["unknown", 1],
  ] as const;
  for (const [field, step] of cases)
    assert.equal(bookingFieldStep(field), step, field);
  assert.equal(
    bookingFieldElementId("scope.requiredCompletion.custom"),
    "partner-book-required-date",
  );
  assert.equal(
    bookingFieldElementId("scope.multiStopDetails.custom"),
    "partner-book-multi-stop-details",
  );
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
          id === "partner-book-work-questions" ? section : null,
      },
    });
    assert.equal(focusBookingField("scope.customRequiredField"), true);
    assert.equal(focused, true);
    assert.equal(focusBookingField("locationId"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("hidden legacy quantities fall back to saved details and open that disclosure", () => {
  let focused = false;
  const savedDetails = {
    tagName: "DETAILS",
    open: false,
    parentElement: null,
    focus() {
      assert.equal(this.open, true);
      focused = true;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) =>
          id === "partner-book-saved-details" ? savedDetails : null,
      },
    });
    assert.equal(focusBookingField("scope.itemCount"), true);
    assert.equal(focused, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("indexed equipment errors focus the selected work, access or saved checkbox", () => {
  const cases = [
    ["0", "partner-book-disassembly", "service"],
    ["1", "partner-book-heavy-items", "service"],
    ["2", "partner-book-access-loading_dock", "contact"],
    ["3", "partner-book-saved-option-lift_gate", "scope"],
  ] as const;
  let focusedId: string | null = null;
  const disclosure = { tagName: "DETAILS", open: false, parentElement: null };
  const targets = new Map(
    cases.map(([index, id, section]) => [
      String(id),
      {
        tagName: "INPUT",
        parentElement: disclosure,
        dataset: {
          partnerEquipmentIndex: index,
          partnerEquipmentSection: section,
        },
        focus() {
          assert.equal(disclosure.open, true);
          focusedId = id;
        },
      },
    ]),
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: (id: string) => targets.get(id) ?? null },
    });
    for (const [index, id, section] of cases) {
      const field = `scope.equipmentNeeds[${index}]`;
      disclosure.open = false;
      assert.equal(bookingErrorSection(field), section, field);
      assert.equal(bookingFieldElementId(field), id, field);
      assert.equal(bookingFieldStep(field), 1, field);
      assert.equal(focusBookingField(field), true, field);
      assert.equal(focusedId, id, field);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("equipment paths never become selectors and unsupported indices use a fixed fallback", () => {
  const lookedUpIds: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById(id: string) {
          lookedUpIds.push(id);
          return null;
        },
      },
    });
    for (const field of [
      "scope.equipmentNeeds",
      "scope.equipmentNeeds[7]",
      "scope.equipmentNeeds.-1",
      "scope.equipmentNeeds[99999999999999999999]",
      'scope.equipmentNeeds[0][id="private-field"]',
      "scope.equipmentNeeds.__proto__",
    ]) {
      assert.equal(bookingFieldElementId(field), "partner-book-equipment");
      assert.equal(bookingErrorSection(field), "contact");
      assert.equal(focusBookingField(field), false);
    }
    assert.deepEqual(
      [...new Set(lookedUpIds)],
      ["partner-book-equipment", "partner-book-contact-name"],
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

void test("focus is safe during server rendering without a document", () => {
  assert.equal(typeof document, "undefined");
  assert.equal(focusBookingField("proofRequirements"), false);
});
