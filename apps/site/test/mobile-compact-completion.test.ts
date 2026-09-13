import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileCompletionFinalTotalFields } from "../src/app/mobile/MobileCompletionFinalTotalFields";
import { CrewPayoutSelector } from "../src/app/team/components/CrewPayoutSelector";
import {
  parseCrewPayoutFormData,
  parseWorkedMinutes,
} from "../src/app/team/lib/crew-payout-form";
import {
  decimalHoursToTimeParts,
  timePartsToDecimalHours,
} from "../src/app/team/lib/crew-worked-time";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const members = [
  { id: alice, name: "Alice" },
  { id: bob, name: "Bob" },
];

function hiddenFormData(markup: string): FormData {
  const data = new FormData();
  for (const input of markup.matchAll(/<input\b[^>]*>/gu)) {
    const name = /name="([^"]*)"/u.exec(input[0])?.[1];
    const value = /value="([^"]*)"/u.exec(input[0])?.[1];
    if (name !== undefined && value !== undefined) data.append(name, value);
  }
  return data;
}

void test("compact crew submits saved moving rates and minutes while the editor is closed", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      compact: true,
      theme: "dark",
      teamMembers: members,
      serviceType: "moving",
      initialCrewMembers: [
        { memberId: alice, hourlyRateCents: 2550, workedMinutes: 151 },
      ],
    }),
  );
  assert.match(markup, /Change crew/);
  assert.match(markup, /2 hr 31 min/);
  assert.doesNotMatch(markup, /Bob|type="number"|type="checkbox"|required=""/u);
  assert.deepEqual(parseCrewPayoutFormData(hiddenFormData(markup)), {
    ok: true,
    crewMembers: [
      { memberId: alice, hourlyRateCents: 2550, workedMinutes: 151 },
    ],
  });
});

void test("compact crew shows the existing editors when required moving labor is missing", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      compact: true,
      teamMembers: members,
      serviceType: "moving",
      initialCrewMembers: [{ memberId: bob }],
    }),
  );
  assert.match(markup, /aria-label="Bob hourly rate"/u);
  assert.match(markup, /aria-label="Bob hours worked"/u);
  assert.match(markup, /aria-label="Bob minutes worked"/u);
  assert.ok(
    markup.indexOf('value="' + bob + '"') <
      markup.indexOf('value="' + alice + '"'),
  );
  assert.doesNotMatch(markup, /Change crew/u);
  assert.equal(parseCrewPayoutFormData(hiddenFormData(markup)).ok, false);
});

void test("compact crew retains an unavailable saved member for explicit removal", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      compact: true,
      teamMembers: [members[0]!],
      initialCrewMembers: [{ memberId: bob }],
    }),
  );
  assert.match(markup, /Unavailable crew member/u);
  assert.match(markup, /type="checkbox"[^>]*checked=""[^>]*value="22222222/u);
});

void test("hours and minutes preserve the existing minute-based completion contract", () => {
  const minutes = [
    ...Array.from({ length: 1440 }, (_, i) => i + 1),
    525_599,
    525_600,
  ];
  for (const total of minutes) {
    const parts = decimalHoursToTimeParts(String(total / 60));
    assert.equal(
      parseWorkedMinutes(timePartsToDecimalHours(parts.hours, parts.minutes)),
      total,
    );
  }
  assert.equal(timePartsToDecimalHours("", "1"), "0.01666667");
  assert.equal(timePartsToDecimalHours("2", "30"), "2.5");
  for (const [hours, minutePart] of [
    ["", ""],
    ["0", "0"],
    ["2", "60"],
    ["-1", "30"],
    ["8760", "1"],
  ]) {
    assert.equal(
      parseWorkedMinutes(timePartsToDecimalHours(hours!, minutePart!)),
      null,
    );
  }
});

void test("compact final total preserves zero and the expected amount without hidden required controls", () => {
  const markup = renderToStaticMarkup(
    createElement(MobileCompletionFinalTotalFields, {
      appointmentId: "test",
      modern: true,
      initialFinalTotalCents: 0,
      quotedTotalCents: 35000,
      initialPaymentSummary: null,
      pricingContext: null,
      canManagePayments: true,
    }),
  );
  assert.match(markup, /Change total/u);
  assert.match(markup, /\$0\.00/u);
  assert.doesNotMatch(markup, /type="number"|required=""/u);
  const form = hiddenFormData(markup);
  assert.equal(form.get("finalTotal"), "0.00");
  assert.equal(form.get("expectedFinalTotalCents"), "0");
});

void test("missing total still exposes the existing required field", () => {
  const markup = renderToStaticMarkup(
    createElement(MobileCompletionFinalTotalFields, {
      appointmentId: "test",
      modern: true,
      initialFinalTotalCents: null,
      quotedTotalCents: null,
      initialPaymentSummary: null,
      pricingContext: null,
      canManagePayments: true,
    }),
  );
  assert.match(markup, /type="number"[^>]*required=""/u);
  assert.doesNotMatch(markup, /Change total/u);
});
