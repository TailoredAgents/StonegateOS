import assert from "node:assert/strict";
import test from "node:test";
import {
  bookingContactErrors,
  chooseBookingContact,
  normalizeBookingContact,
  type PartnerContactAccessValues,
} from "./booking-contact";

const values = (
  changes: Partial<PartnerContactAccessValues> = {},
): PartnerContactAccessValues => ({
  contactName: "Morgan Lee",
  contactPhone: "",
  contactEmail: "morgan@example.test",
  alternateContactName: "",
  alternateContactPhone: "",
  alternateContactEmail: "",
  accessDetails: "",
  crewInstructions: "",
  ...changes,
});

void test("normalization creates a coherent contact without mutating its source", () => {
  const source = Object.freeze({ name: "  Morgan Lee  ", phone: "  " });
  assert.deepEqual(normalizeBookingContact(source), {
    name: "Morgan Lee",
    phone: "",
    email: "",
  });
  assert.equal(source.name, "  Morgan Lee  ");
  assert.deepEqual(normalizeBookingContact(), {
    name: "",
    phone: "",
    email: "",
  });
  assert.deepEqual(normalizeBookingContact(null), normalizeBookingContact());
});

void test("location contact selection never mixes two people's details", () => {
  const requester = {
    name: "Requesting person",
    phone: "404 555 0101",
    email: "requester@example.test",
  };
  assert.deepEqual(chooseBookingContact({ name: "Site person" }, requester), {
    name: "Site person",
    phone: "",
    email: "",
  });
  assert.deepEqual(chooseBookingContact({ phone: "404 555 0102" }, requester), {
    name: "",
    phone: "404 555 0102",
    email: "",
  });
  assert.deepEqual(
    chooseBookingContact({ name: " \t " }, requester),
    requester,
  );
  assert.deepEqual(chooseBookingContact(null, requester), requester);
  assert.deepEqual(chooseBookingContact(), normalizeBookingContact());
});

void test("a primary contact may use email or a phone without an optional backup", () => {
  assert.deepEqual(bookingContactErrors(values()), {});
  assert.deepEqual(
    bookingContactErrors(
      values({ contactPhone: "(404) 555-0101 ext. 2", contactEmail: "" }),
    ),
    {},
  );
  assert.deepEqual(
    bookingContactErrors(
      values({
        alternateContactName: " ",
        alternateContactPhone: "\t",
        alternateContactEmail: "\n",
      }),
    ),
    {},
  );
});

void test("cleared primary fields retain the established required-field error paths", () => {
  assert.deepEqual(
    Object.keys(
      bookingContactErrors(
        values({ contactName: " ", contactPhone: "", contactEmail: "" }),
      ),
    ),
    ["onSiteContact", "contactMethod"],
  );
});

void test("optional backup requires a name and either a phone or email once started", () => {
  assert.deepEqual(
    Object.keys(
      bookingContactErrors(values({ alternateContactName: "Backup person" })),
    ),
    ["scope.alternateContact.phone"],
  );
  assert.deepEqual(
    Object.keys(
      bookingContactErrors(
        values({ alternateContactEmail: "backup@example.test" }),
      ),
    ),
    ["scope.alternateContact.name"],
  );
  assert.deepEqual(
    bookingContactErrors(
      values({
        alternateContactName: "Backup person",
        alternateContactEmail: "backup@example.test",
      }),
    ),
    {},
  );
  assert.deepEqual(
    bookingContactErrors(
      values({
        alternateContactName: "Backup person",
        alternateContactPhone: "+1 (404) 555-0102 ext 7",
      }),
    ),
    {},
  );
});

void test("invalid supplied emails are rejected even when a phone is present", () => {
  const errors = bookingContactErrors(
    values({
      contactPhone: "4045550101",
      contactEmail: "missing-at.example.test",
      alternateContactName: "Backup person",
      alternateContactPhone: "4045550102",
      alternateContactEmail: "backup@example",
    }),
  );
  assert.deepEqual(Object.keys(errors), [
    "onSiteContact.email",
    "scope.alternateContact.email",
  ]);
});

void test("backup validation matches API text limits and Unicode normalization", () => {
  assert.deepEqual(
    bookingContactErrors(
      values({
        alternateContactName: "N".repeat(200),
        alternateContactPhone: "P".repeat(50),
        alternateContactEmail: `${"a".repeat(307)}@example.test`,
      }),
    ),
    {},
  );
  assert.deepEqual(
    Object.keys(
      bookingContactErrors(
        values({
          alternateContactName: "N".repeat(201),
          alternateContactPhone: "P".repeat(51),
          alternateContactEmail: `${"a".repeat(308)}@example.test`,
        }),
      ),
    ).sort(),
    [
      "scope.alternateContact.email",
      "scope.alternateContact.name",
      "scope.alternateContact.phone",
    ],
  );
  assert.deepEqual(
    bookingContactErrors(
      values({
        alternateContactName: "Backup person",
        alternateContactEmail: "backup＠example.test",
      }),
    ),
    {},
  );
  assert.ok(
    bookingContactErrors(
      values({
        alternateContactName: "Backup\u0000person",
        alternateContactPhone: "4045550102",
      }),
    )["scope.alternateContact.name"],
  );
});

void test("clearing a backup removes its validation errors and preserves other fields", () => {
  const incomplete = values({
    alternateContactName: "Backup person",
    accessDetails: "Use the side door",
    crewInstructions: "Keep the marked shelf",
  });
  assert.ok(bookingContactErrors(incomplete)["scope.alternateContact.phone"]);
  const cleared = {
    ...incomplete,
    alternateContactName: "",
    alternateContactPhone: "",
    alternateContactEmail: "",
  };
  assert.deepEqual(bookingContactErrors(cleared), {});
  assert.equal(cleared.accessDetails, incomplete.accessDetails);
  assert.equal(cleared.crewInstructions, incomplete.crewInstructions);
  assert.equal(cleared.contactEmail, incomplete.contactEmail);
});
