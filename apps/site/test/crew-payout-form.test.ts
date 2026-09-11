import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CrewPayoutSelector } from "../src/app/team/components/CrewPayoutSelector";
import {
  hourlyPayoutCents,
  parseCrewPayoutFormData,
  parseHourlyRateCents,
  parseWorkedMinutes,
} from "../src/app/team/lib/crew-payout-form";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
function movingForm(): FormData {
  const data = new FormData();
  data.set("crewCompensationMode", "hourly");
  data.append("crewMemberId", alice);
  data.append("crewMemberId", bob);
  data.set(`crewHourlyRate:${alice}`, "25.50");
  data.set(`crewHours:${alice}`, "2.5");
  data.set(`crewHourlyRate:${bob}`, "30");
  data.set(`crewHours:${bob}`, "3.25");
  return data;
}

test("moving completion carries each person's exact rate and worked minutes", () => {
  const data = movingForm();
  data.append("crewMemberId", alice);
  assert.deepEqual(parseCrewPayoutFormData(data), {
    ok: true,
    crewMembers: [
      { memberId: alice, hourlyRateCents: 2550, workedMinutes: 150 },
      { memberId: bob, hourlyRateCents: 3000, workedMinutes: 195 },
    ],
  });
  assert.equal(hourlyPayoutCents(2550, 150), 6375);
  assert.equal(hourlyPayoutCents(3000, 195), 9750);
});

test("unselected rows do not pay and nonmoving crew submits equal percentage weights", () => {
  const data = movingForm();
  data.delete("crewMemberId");
  data.append("crewMemberId", bob);
  assert.deepEqual(parseCrewPayoutFormData(data), {
    ok: true,
    crewMembers: [{ memberId: bob, hourlyRateCents: 3000, workedMinutes: 195 }],
  });
  assert.deepEqual(parseCrewPayoutFormData(data, false), {
    ok: true,
    crewMembers: [{ memberId: bob, splitBps: 1 }],
  });
});

test("conversion uses the selected service and rejects missing moving labor inputs", () => {
  const data = movingForm();
  data.set("crewCompensationMode", "percentage");
  data.delete(`crewHours:${alice}`);
  assert.equal(parseCrewPayoutFormData(data, true).ok, false);
  data.delete("crewMemberId");
  assert.equal(parseCrewPayoutFormData(data).ok, false);
});

test("hourly inputs reject invalid money, nonpositive hours and numeric overflow", () => {
  for (const invalid of [
    "",
    "0",
    "-5",
    "25.501",
    "Infinity",
    "1e3",
    "21474836.48",
  ]) {
    assert.equal(parseHourlyRateCents(invalid), null, invalid);
  }
  for (const invalid of ["", "0", "-2", "0.001", "Infinity", "1e3", "8761"]) {
    assert.equal(parseWorkedMinutes(invalid), null, invalid);
  }
  assert.equal(parseHourlyRateCents("0.29"), 29);
  assert.equal(parseWorkedMinutes("2.333333"), 140);
  assert.equal(hourlyPayoutCents(2_147_483_647, 61), null);
  assert.equal(hourlyPayoutCents(2500, 1), 42);
  assert.equal(hourlyPayoutCents(1, 1), 0);
  const overflowingCrew = movingForm();
  for (const memberId of [alice, bob]) {
    overflowingCrew.set(`crewHourlyRate:${memberId}`, "21474836.47");
    overflowingCrew.set(`crewHours:${memberId}`, "1");
  }
  assert.equal(parseCrewPayoutFormData(overflowingCrew).ok, false);
});

test("moving correction prefills saved crew, rate and time without duplicate selection cards", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      teamMembers: [
        { id: alice, name: "Alice" },
        { id: bob, name: "Bob" },
      ],
      serviceType: "moving",
      theme: "dark",
      stacked: true,
      initialCrewMembers: [
        { memberId: alice, hourlyRateCents: 2550, workedMinutes: 150 },
      ],
    }),
  );
  assert.match(markup, /Who worked.*Hourly pay/);
  assert.match(markup, /name="crewCompensationMode" value="hourly"/);
  assert.match(markup, /aria-label="Alice hourly rate"[^>]*value="25.50"/);
  assert.match(markup, /aria-label="Alice hours worked"[^>]*value="2.5"/);
  assert.match(markup, /Crew labor total/);
  assert.match(markup, /\$63.75/);
  assert.equal((markup.match(/name="crewMemberId"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /aria-label="Bob hourly rate"/);
});

test("percentage completion keeps hourly fields out of the form", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      teamMembers: [{ id: alice, name: "Alice" }],
      serviceType: "junk_removal",
      initialCrewMembers: [{ memberId: alice }],
    }),
  );
  assert.match(markup, /name="crewCompensationMode" value="percentage"/);
  assert.doesNotMatch(markup, /crewHourlyRate|crewHours|Crew labor total/);
  assert.match(markup, /20% labor pool/);
  assert.match(markup, /20% of the job total per person/);
});

test("completion includes all four staff and previews the crew-size pool and equal pay", () => {
  const teamMembers = [
    { id: alice, name: "Jeffrey" },
    { id: bob, name: "Jed" },
    { id: "33333333-3333-4333-8333-333333333333", name: "Austin" },
    { id: "44444444-4444-4444-8444-444444444444", name: "Devon" },
  ];
  for (const [crewCount, pool, perPerson] of [
    [1, 20, 20],
    [2, 20, 10],
    [3, 30, 10],
    [4, 30, 7.5],
  ]) {
    const markup = renderToStaticMarkup(
      createElement(CrewPayoutSelector, {
        teamMembers,
        serviceType: "junk_removal",
        initialCrewMembers: teamMembers
          .slice(0, crewCount)
          .map((member) => ({ memberId: member.id })),
      }),
    );
    assert.equal((markup.match(/name="crewMemberId"/g) ?? []).length, 4);
    assert.match(markup, /Devon/);
    assert.ok(markup.includes(`${pool}% labor pool`));
    assert.ok(markup.includes(`${perPerson}% of the job total per person`));
    assert.match(markup, /Payroll and job expenses update when saved/);
    assert.doesNotMatch(
      markup,
      /current crew split|Payroll split|crewHourlyRate/,
    );
  }
});

test("percentage completion asks for crew selection before showing a payout", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      teamMembers: [{ id: alice, name: "Jeffrey" }],
    }),
  );
  assert.match(markup, /Select at least one crew member/);
  assert.doesNotMatch(markup, /0% labor pool|of the job total per person/);
});

test("convert-only can save booking details without completing optional crew inputs", () => {
  const markup = renderToStaticMarkup(
    createElement(CrewPayoutSelector, {
      teamMembers: [{ id: alice, name: "Alice" }],
      serviceType: "moving",
      initialCrewMembers: [{ memberId: alice }],
      requireHourlyInputs: false,
    }),
  );
  assert.match(markup, /crewHourlyRate/);
  assert.doesNotMatch(markup, /required=""/);
});
