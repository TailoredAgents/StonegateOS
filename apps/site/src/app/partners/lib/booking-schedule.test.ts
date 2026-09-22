import assert from "node:assert/strict";
import test from "node:test";
import {
  preferredScheduleErrors,
  restorePreferredSchedule,
  serializePreferredSchedule,
  type PartnerPreferredScheduleValues,
} from "./booking-schedule";

const values = (
  overrides: Partial<PartnerPreferredScheduleValues> = {},
): PartnerPreferredScheduleValues => ({
  ...restorePreferredSchedule([], "America/New_York"),
  preferredDateOne: "2028-02-29",
  ...overrides,
});

void test("saved dates retain their individual time preferences through restoration and saving", () => {
  const windows = Object.freeze([
    Object.freeze({
      localDate: "2028-02-10",
      timeOfDay: "morning",
      timezone: "America/New_York",
    }),
    Object.freeze({
      localDate: "2028-02-12",
      timeOfDay: "afternoon",
      timezone: "America/New_York",
    }),
    Object.freeze({
      localDate: "2028-02-15",
      timeOfDay: "anytime",
      timezone: "America/New_York",
    }),
  ]);
  const restored = restorePreferredSchedule(windows, "America/Chicago");
  assert.equal(restored.preferredTimeOfDay, "morning");
  assert.equal(restored.preferredTimeOfDayTwo, "afternoon");
  assert.equal(restored.preferredTimeOfDayThree, "anytime");
  assert.deepEqual(serializePreferredSchedule(restored), windows);
});

void test("empty alternative dates inherit the first preference without inventing dates", () => {
  const restored = restorePreferredSchedule(
    [{ localDate: "2028-02-12", timeOfDay: "afternoon" }],
    "America/Chicago",
  );
  assert.equal(restored.preferredDateTwo, "");
  assert.equal(restored.preferredDateThree, "");
  assert.equal(restored.preferredTimeOfDayTwo, "afternoon");
  assert.equal(restored.preferredTimeOfDayThree, "afternoon");
  assert.equal(restored.preferredTimezone, "America/Chicago");
  assert.deepEqual(serializePreferredSchedule(restored), [
    {
      localDate: "2028-02-12",
      timeOfDay: "afternoon",
      timezone: "America/Chicago",
    },
  ]);
  assert.deepEqual(
    serializePreferredSchedule(
      restorePreferredSchedule([], "America/New_York"),
    ),
    [],
  );
});

void test("clearing an alternative removes only its date and keeps the later date's own time", () => {
  const restored = values({
    preferredDateOne: "2028-02-10",
    preferredTimeOfDay: "morning",
    preferredDateTwo: "2028-02-11",
    preferredTimeOfDayTwo: "afternoon",
    preferredDateThree: "2028-02-12",
    preferredTimeOfDayThree: "anytime",
  });
  const cleared = Object.freeze({ ...restored, preferredDateTwo: "" });
  assert.deepEqual(serializePreferredSchedule(cleared), [
    {
      localDate: "2028-02-10",
      timeOfDay: "morning",
      timezone: "America/New_York",
    },
    {
      localDate: "2028-02-12",
      timeOfDay: "anytime",
      timezone: "America/New_York",
    },
  ]);
  assert.equal(cleared.preferredTimeOfDayTwo, "afternoon");
  assert.equal(restored.preferredDateTwo, "2028-02-11");
});

void test("serialization uses the authoritative shared zone and skips blank dates", () => {
  assert.deepEqual(
    serializePreferredSchedule(
      values({
        preferredDateTwo: " \t ",
        preferredDateThree: "2028-03-01",
        preferredTimeOfDayThree: "morning",
        preferredTimezone: "America/Los_Angeles",
      }),
    ),
    [
      {
        localDate: "2028-02-29",
        timeOfDay: "anytime",
        timezone: "America/Los_Angeles",
      },
      {
        localDate: "2028-03-01",
        timeOfDay: "morning",
        timezone: "America/Los_Angeles",
      },
    ],
  );
});

void test("the main date is required even when an alternative date is filled", () => {
  const errors = preferredScheduleErrors(
    values({ preferredDateOne: "", preferredDateThree: "2028-02-29" }),
    "2028-02-01",
    "2028-03-02",
  );
  assert.deepEqual(Object.keys(errors), ["preferredDateOne"]);
  assert.match(errors["preferredDateOne"] ?? "", /preferred service date/u);
});

void test("calendar validation accepts leap days and inclusive location-date boundaries", () => {
  assert.deepEqual(
    preferredScheduleErrors(
      values({
        preferredDateOne: "2028-02-01",
        preferredDateTwo: "2028-02-29",
        preferredDateThree: "2028-03-02",
        preferredTimezone: "Pacific/Kiritimati",
      }),
      "2028-02-01",
      "2028-03-02",
    ),
    {},
  );
  assert.deepEqual(
    Object.keys(
      preferredScheduleErrors(
        values({
          preferredDateOne: "2028-01-31",
          preferredDateThree: "2028-03-03",
        }),
        "2028-02-01",
        "2028-03-02",
      ),
    ),
    ["preferredDateOne", "preferredDateThree"],
  );
});

void test("invalid dates are rejected without JavaScript calendar rollover", () => {
  for (const date of [
    "2027-02-29",
    "2028-02-30",
    "2028-04-31",
    "2028-00-10",
    "2028-13-01",
    "2028-2-09",
    "2028-02-29T12:00:00Z",
    "not-a-date",
  ]) {
    const errors = preferredScheduleErrors(
      values({ preferredDateTwo: date, preferredDateThree: date }),
      "2027-01-01",
      "2028-12-31",
    );
    assert.equal(
      errors["preferredDateTwo"],
      "Choose a valid service date.",
      date,
    );
    assert.equal(
      errors["preferredDateThree"],
      "Choose a valid service date.",
      date,
    );
  }
});

void test("duplicate dates flag the later fixed slots without changing or merging preferences", () => {
  const input = Object.freeze(
    values({
      preferredDateTwo: "2028-02-29",
      preferredTimeOfDayTwo: "afternoon",
      preferredDateThree: "2028-02-29",
      preferredTimeOfDayThree: "morning",
    }),
  );
  const errors = preferredScheduleErrors(input, "2028-02-01", "2028-03-02");
  assert.deepEqual(Object.keys(errors), [
    "preferredDateTwo",
    "preferredDateThree",
  ]);
  assert.match(errors["preferredDateTwo"] ?? "", /different date/u);
  assert.match(errors["preferredDateThree"] ?? "", /different date/u);
  assert.equal(input.preferredTimeOfDayTwo, "afternoon");
  assert.equal(input.preferredTimeOfDayThree, "morning");
});
