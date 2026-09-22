type PreferredTimeOfDay = "anytime" | "morning" | "afternoon";

export type PartnerPreferredScheduleValues = {
  preferredDateOne: string;
  preferredDateTwo: string;
  preferredDateThree: string;
  preferredTimeOfDay: PreferredTimeOfDay;
  preferredTimeOfDayTwo: PreferredTimeOfDay;
  preferredTimeOfDayThree: PreferredTimeOfDay;
  preferredTimezone: string;
};

function timePreference(
  value: unknown,
  fallback: PreferredTimeOfDay,
): PreferredTimeOfDay {
  return value === "anytime" || value === "morning" || value === "afternoon"
    ? value
    : fallback;
}

export function restorePreferredSchedule(
  windows: ReadonlyArray<Record<string, unknown>>,
  fallbackTimezone: string,
): PartnerPreferredScheduleValues {
  const date = (index: number): string => {
    const value = windows[index]?.["localDate"];
    return typeof value === "string" ? value : "";
  };
  const firstTime = timePreference(windows[0]?.["timeOfDay"], "anytime");
  const timezone = windows[0]?.["timezone"];
  return {
    preferredDateOne: date(0),
    preferredDateTwo: date(1),
    preferredDateThree: date(2),
    preferredTimeOfDay: firstTime,
    preferredTimeOfDayTwo: timePreference(windows[1]?.["timeOfDay"], firstTime),
    preferredTimeOfDayThree: timePreference(
      windows[2]?.["timeOfDay"],
      firstTime,
    ),
    preferredTimezone:
      typeof timezone === "string" && timezone.trim()
        ? timezone.trim()
        : fallbackTimezone,
  };
}

export function serializePreferredSchedule(
  values: PartnerPreferredScheduleValues,
): { localDate: string; timeOfDay: PreferredTimeOfDay; timezone: string }[] {
  return [
    {
      localDate: values.preferredDateOne,
      timeOfDay: values.preferredTimeOfDay,
    },
    {
      localDate: values.preferredDateTwo,
      timeOfDay: values.preferredTimeOfDayTwo,
    },
    {
      localDate: values.preferredDateThree,
      timeOfDay: values.preferredTimeOfDayThree,
    },
  ]
    .filter(({ localDate }) => localDate.trim().length > 0)
    .map((window) => ({ ...window, timezone: values.preferredTimezone }));
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** Bounds are calendar dates already calculated in the service location's zone. */
export function preferredScheduleErrors(
  values: PartnerPreferredScheduleValues,
  minimum: string,
  maximum: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const fields = [
    "preferredDateOne",
    "preferredDateTwo",
    "preferredDateThree",
  ] as const;
  for (const [index, field] of fields.entries()) {
    const date = values[field];
    if (!date.trim()) {
      if (index === 0) errors[field] = "Choose your preferred service date.";
      continue;
    }
    if (!isCalendarDate(date)) {
      errors[field] = "Choose a valid service date.";
      continue;
    }
    if (date < minimum || date > maximum) {
      errors[field] = "Choose a date from tomorrow through 30 days from now.";
      continue;
    }
    if (seen.has(date)) {
      errors[field] = "Choose a different date for each preference.";
      continue;
    }
    seen.add(date);
  }
  return errors;
}
