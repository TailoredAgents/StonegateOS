import { SchedulingDomainError } from "./errors";
import type { BookingRulesPolicy, BusinessHoursPolicy } from "../policy";
import {
  SCHEDULING_CHANNELS,
  SCHEDULING_WEEKDAYS,
  type LocalMinuteWindow,
  type ScheduleCapacityPool,
  type ScheduleChannelPolicy,
  type ScheduleDateOverride,
  type SchedulePolicySnapshot,
  type SchedulingChannel,
  type SchedulingWeekday,
} from "./types";

export const DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES = 30;
export const DEFAULT_PARTNER_WINDOW_MINUTES = 120;
export const DEFAULT_SCHEDULE_HOLD_TTL_MINUTES = 15;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CAPACITY_POOL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function invalidPolicy(message: string): never {
  throw new SchedulingDomainError("invalid_policy", message, {
    status: 500,
  });
}

function requireInteger(
  value: number,
  minimum: number,
  maximum: number,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalidPolicy(message);
  }
  return value;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizeWindows(
  windows: readonly LocalMinuteWindow[],
): readonly LocalMinuteWindow[] {
  const normalized = windows
    .map((window) => {
      const startMinute = requireInteger(
        window.startMinute,
        0,
        1439,
        "A business-hours start is invalid.",
      );
      const endMinute = requireInteger(
        window.endMinute,
        1,
        1440,
        "A business-hours end is invalid.",
      );
      if (endMinute <= startMinute) {
        return invalidPolicy(
          "A business-hours window must end after it starts.",
        );
      }
      return Object.freeze({ startMinute, endMinute });
    })
    .sort((left, right) => left.startMinute - right.startMinute);

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous && current && current.startMinute < previous.endMinute) {
      return invalidPolicy("Business-hours windows cannot overlap.");
    }
  }
  return Object.freeze(normalized);
}

function normalizeWeeklyHours(
  weeklyHours: SchedulePolicySnapshot["weeklyHours"],
): SchedulePolicySnapshot["weeklyHours"] {
  const normalized = {} as Record<
    SchedulingWeekday,
    readonly LocalMinuteWindow[]
  >;
  for (const weekday of SCHEDULING_WEEKDAYS) {
    const windows = weeklyHours[weekday];
    if (!Array.isArray(windows)) {
      return invalidPolicy(`Business hours are missing for ${weekday}.`);
    }
    normalized[weekday] = normalizeWindows(windows);
  }
  return Object.freeze(normalized);
}

function normalizeCapacityPools(
  capacityPools: SchedulePolicySnapshot["capacityPools"],
): SchedulePolicySnapshot["capacityPools"] {
  const normalized: Record<string, ScheduleCapacityPool> = {};
  for (const [recordKey, pool] of Object.entries(capacityPools)) {
    const key = pool.key.trim().toLowerCase();
    if (
      !CAPACITY_POOL_KEY_PATTERN.test(key) ||
      recordKey !== key ||
      normalized[key]
    ) {
      return invalidPolicy("A schedule capacity pool key is invalid.");
    }
    normalized[key] = Object.freeze({
      key,
      capacityUnits: requireInteger(
        pool.capacityUnits,
        1,
        10_000,
        "A schedule capacity value is invalid.",
      ),
    });
  }
  if (Object.keys(normalized).length === 0) {
    return invalidPolicy("At least one schedule capacity pool is required.");
  }
  return Object.freeze(normalized);
}

function normalizeChannelPolicy(
  channel: SchedulingChannel,
  value: ScheduleChannelPolicy,
): ScheduleChannelPolicy {
  if (!value || typeof value.allowsInstantConfirmation !== "boolean") {
    return invalidPolicy(`The ${channel} scheduling policy is invalid.`);
  }
  return Object.freeze({
    minimumNoticeMinutes: requireInteger(
      value.minimumNoticeMinutes,
      0,
      365 * 24 * 60,
      `The ${channel} minimum notice is invalid.`,
    ),
    minimumCalendarLeadDays: requireInteger(
      value.minimumCalendarLeadDays,
      0,
      365,
      `The ${channel} calendar lead is invalid.`,
    ),
    allowsInstantConfirmation: value.allowsInstantConfirmation,
  });
}

function normalizeChannels(
  channels: SchedulePolicySnapshot["channels"],
): SchedulePolicySnapshot["channels"] {
  const normalized = {} as Record<SchedulingChannel, ScheduleChannelPolicy>;
  for (const channel of SCHEDULING_CHANNELS) {
    normalized[channel] = normalizeChannelPolicy(channel, channels[channel]);
  }
  return Object.freeze(normalized);
}

function normalizeDateOverrides(
  overrides: readonly ScheduleDateOverride[],
  capacityPools: SchedulePolicySnapshot["capacityPools"],
): readonly ScheduleDateOverride[] {
  const seenDates = new Set<string>();
  const normalized = overrides.map((override) => {
    if (
      !isValidLocalDate(override.localDate) ||
      seenDates.has(override.localDate)
    ) {
      return invalidPolicy(
        "A schedule date override is invalid or duplicated.",
      );
    }
    seenDates.add(override.localDate);
    if (typeof override.closed !== "boolean") {
      return invalidPolicy("A schedule date override state is invalid.");
    }
    if (override.closed && override.windows && override.windows.length > 0) {
      return invalidPolicy(
        "A closed date override cannot contain open windows.",
      );
    }

    let capacityByPool: Readonly<Record<string, number>> | undefined;
    if (override.capacityByPool) {
      const capacities: Record<string, number> = {};
      for (const [poolKey, units] of Object.entries(override.capacityByPool)) {
        if (!capacityPools[poolKey]) {
          return invalidPolicy(
            "A date override references an unknown capacity pool.",
          );
        }
        capacities[poolKey] = requireInteger(
          units,
          0,
          10_000,
          "A date-specific schedule capacity is invalid.",
        );
      }
      capacityByPool = Object.freeze(capacities);
    }

    return Object.freeze({
      localDate: override.localDate,
      closed: override.closed,
      ...(override.windows
        ? { windows: normalizeWindows(override.windows) }
        : {}),
      ...(capacityByPool ? { capacityByPool } : {}),
    });
  });
  return Object.freeze(
    normalized.sort((left, right) =>
      left.localDate.localeCompare(right.localDate),
    ),
  );
}

/** Validates, normalizes, clones, and freezes one transactional policy view. */
export function createSchedulePolicySnapshot(
  input: SchedulePolicySnapshot,
): SchedulePolicySnapshot {
  const revision = input.revision.trim();
  const timezone = input.timezone.trim();
  if (!revision || revision.length > 128) {
    return invalidPolicy("The schedule policy revision is invalid.");
  }
  if (!timezone || !isValidTimezone(timezone)) {
    return invalidPolicy("The schedule timezone is invalid.");
  }

  const slotIntervalMinutes = requireInteger(
    input.slotIntervalMinutes,
    5,
    120,
    "The schedule slot interval is invalid.",
  );
  const partnerWindowMinutes = requireInteger(
    input.partnerWindowMinutes,
    slotIntervalMinutes,
    8 * 60,
    "The partner availability window is invalid.",
  );
  if (partnerWindowMinutes % slotIntervalMinutes !== 0) {
    return invalidPolicy(
      "The partner window must be a multiple of the slot interval.",
    );
  }

  const capacityPools = normalizeCapacityPools(input.capacityPools);
  return Object.freeze({
    revision,
    timezone,
    slotIntervalMinutes,
    partnerWindowMinutes,
    holdTtlMinutes: requireInteger(
      input.holdTtlMinutes,
      1,
      24 * 60,
      "The schedule hold lifetime is invalid.",
    ),
    bookingWindowDays: requireInteger(
      input.bookingWindowDays,
      1,
      365,
      "The schedule booking window is invalid.",
    ),
    defaultTravelBufferMinutes: requireInteger(
      input.defaultTravelBufferMinutes,
      0,
      24 * 60,
      "The default travel buffer is invalid.",
    ),
    maxJobsPerDay: requireInteger(
      input.maxJobsPerDay,
      0,
      10_000,
      "The maximum daily job count is invalid.",
    ),
    weeklyHours: normalizeWeeklyHours(input.weeklyHours),
    dateOverrides: normalizeDateOverrides(input.dateOverrides, capacityPools),
    capacityPools,
    channels: normalizeChannels(input.channels),
  });
}

function localTimeToMinute(value: string): number {
  const match = LOCAL_TIME_PATTERN.exec(value.trim());
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(hour) || !Number.isSafeInteger(minute)) {
    return invalidPolicy("A legacy business-hours time is invalid.");
  }
  return hour * 60 + minute;
}

/**
 * Compatibility adapter for the existing policy center. It is type-only
 * coupled to `policy.ts`, so importing this pure domain does not initialize a
 * database client. `maxJobsPerCrew` is intentionally not translated because
 * the current data model has no pre-booking crew availability primitive.
 */
export function createSchedulePolicySnapshotFromLegacy(input: {
  revision: string;
  businessHours: BusinessHoursPolicy;
  bookingRules: BookingRulesPolicy;
  capacityUnits: number;
  channels: SchedulePolicySnapshot["channels"];
  capacityPoolKey?: string;
  dateOverrides?: readonly ScheduleDateOverride[];
  slotIntervalMinutes?: number;
  partnerWindowMinutes?: number;
  holdTtlMinutes?: number;
}): SchedulePolicySnapshot {
  const weeklyHours = {} as Record<
    SchedulingWeekday,
    readonly LocalMinuteWindow[]
  >;
  for (const weekday of SCHEDULING_WEEKDAYS) {
    weeklyHours[weekday] = input.businessHours.weekly[weekday].map(
      (window) => ({
        startMinute: localTimeToMinute(window.start),
        endMinute:
          window.end.trim() === "24:00" ? 1440 : localTimeToMinute(window.end),
      }),
    );
  }
  const capacityPoolKey = (input.capacityPoolKey ?? "field_service").trim();

  return createSchedulePolicySnapshot({
    revision: input.revision,
    timezone: input.businessHours.timezone,
    slotIntervalMinutes:
      input.slotIntervalMinutes ?? DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES,
    partnerWindowMinutes:
      input.partnerWindowMinutes ?? DEFAULT_PARTNER_WINDOW_MINUTES,
    holdTtlMinutes: input.holdTtlMinutes ?? DEFAULT_SCHEDULE_HOLD_TTL_MINUTES,
    bookingWindowDays: input.bookingRules.bookingWindowDays,
    defaultTravelBufferMinutes: input.bookingRules.bufferMinutes,
    maxJobsPerDay: input.bookingRules.maxJobsPerDay,
    weeklyHours,
    dateOverrides: input.dateOverrides ?? [],
    capacityPools: {
      [capacityPoolKey]: {
        key: capacityPoolKey,
        capacityUnits: input.capacityUnits,
      },
    },
    channels: input.channels,
  });
}
