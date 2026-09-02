import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PARTNER_SCHEDULE_ASSISTANCE_OPTIONS,
  scheduleAssistanceSummary,
  visibleRankedPartnerAlternatives,
} from "./partner-scheduling-assistance";
import type { PartnerAvailability } from "./portal-v2";

const bookingWizard = readFileSync(
  new URL("../components/PartnerBookingWizard.tsx", import.meta.url),
  "utf8",
);
const bookingPage = readFileSync(
  new URL("../(portal)/book/page.tsx", import.meta.url),
  "utf8",
);

function alternative(
  id: string,
  rank: number,
  available = true,
): PartnerAvailability["rankedAlternatives"][number] {
  return {
    id,
    localDate: "2026-09-08",
    startAt: `2026-09-08T${id}:00.000Z`,
    endAt: `2026-09-08T${id}:00.000Z`,
    label: id,
    available,
    rank,
    reason: rank === 1 ? "soonest_available" : "more_capacity",
  };
}

void test("offers an explicit durable waitlist, callback, and no-follow-up choice", () => {
  assert.deepEqual(
    PARTNER_SCHEDULE_ASSISTANCE_OPTIONS.map(({ value }) => value),
    ["waitlist", "callback", "none"],
  );
  assert.equal(
    scheduleAssistanceSummary("waitlist"),
    "Scheduling waitlist requested",
  );
  assert.equal(
    scheduleAssistanceSummary("callback"),
    "Scheduling callback requested",
  );
  assert.equal(scheduleAssistanceSummary("none"), null);
});

void test("shows only unique, available server-ranked alternatives in rank order", () => {
  assert.deepEqual(
    visibleRankedPartnerAlternatives([
      alternative("14:00", 2),
      alternative("13:00", 1),
      alternative("13:00", 1),
      alternative("15:00", 3, false),
    ]).map(({ id }) => id),
    ["13:00", "14:00"],
  );
});

void test("renders ranked choices, a durable follow-up choice, and an honest urgent call path", () => {
  assert.match(bookingWizard, /Recommended available windows/u);
  assert.match(bookingWizard, /PARTNER_SCHEDULE_ASSISTANCE_OPTIONS\.map/u);
  assert.match(bookingWizard, /href=\{`tel:\$\{supportPhoneE164\}`\}/u);
  assert.match(bookingWizard, /Calling does not reserve capacity/u);
  assert.match(bookingPage, /supportPhoneE164=\{company\.phoneE164\}/u);
  assert.match(bookingPage, /supportPhoneDisplay=\{company\.phoneDisplay\}/u);
});
