import { DateTime } from "luxon";
import { SchedulingDomainError } from "./errors";
import {
  DEFAULT_PARTNER_WINDOW_MINUTES,
  DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES,
} from "./policy";

export type PartnerWindowCandidate = Readonly<{
  id: string;
  startAt: Date;
  available: boolean;
}>;

export type PartnerWindowAvailability = "none" | "partial" | "full";

export type PartnerAvailabilityWindow<T extends PartnerWindowCandidate> =
  Readonly<{
    id: string;
    localDate: string;
    startAt: Date;
    endAt: Date;
    label: string;
    availability: PartnerWindowAvailability;
    available: boolean;
    completeGrid: boolean;
    candidates: readonly T[];
    availableCandidates: readonly T[];
  }>;

function invalidGrid(message: string): never {
  throw new SchedulingDomainError("invalid_candidate_grid", message, {
    status: 500,
  });
}

function requireValidTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized || !DateTime.local().setZone(normalized).isValid) {
    return invalidGrid("The partner availability timezone is invalid.");
  }
  return normalized;
}

function requireGridMinutes(
  value: number,
  minimum: number,
  maximum: number,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalidGrid(message);
  }
  return value;
}

function labelForWindow(start: DateTime, end: DateTime): string {
  const startLabel = start.toLocaleString(DateTime.TIME_SIMPLE);
  const endLabel = end.toLocaleString(DateTime.TIME_SIMPLE);
  return `${startLabel}–${endLabel}`;
}

/**
 * Groups an exact candidate grid into non-overlapping presentation windows.
 * The candidates remain independently selectable/reservable; the two-hour
 * window is never substituted for service duration.
 */
export function groupPartnerAvailabilityWindows<
  T extends PartnerWindowCandidate,
>(
  candidates: readonly T[],
  options: {
    timezone: string;
    candidateIntervalMinutes?: number;
    windowMinutes?: number;
    /** Optional per-date business-window anchor, expressed after midnight. */
    anchorMinuteByLocalDate?: Readonly<Record<string, number>>;
  },
): readonly PartnerAvailabilityWindow<T>[] {
  const timezone = requireValidTimezone(options.timezone);
  const candidateIntervalMinutes = requireGridMinutes(
    options.candidateIntervalMinutes ?? DEFAULT_SCHEDULE_SLOT_INTERVAL_MINUTES,
    5,
    120,
    "The partner candidate interval is invalid.",
  );
  const windowMinutes = requireGridMinutes(
    options.windowMinutes ?? DEFAULT_PARTNER_WINDOW_MINUTES,
    candidateIntervalMinutes,
    8 * 60,
    "The partner availability window is invalid.",
  );
  if (windowMinutes % candidateIntervalMinutes !== 0) {
    return invalidGrid(
      "The partner window must be a multiple of the candidate interval.",
    );
  }
  const expectedCandidates = windowMinutes / candidateIntervalMinutes;

  const seenIds = new Set<string>();
  const seenInstants = new Set<number>();
  const candidatesByDate = new Map<
    string,
    Array<{ candidate: T; local: DateTime; minuteOfDay: number }>
  >();
  for (const candidate of candidates) {
    const id = candidate.id.trim();
    const instant = candidate.startAt?.getTime();
    if (
      !id ||
      seenIds.has(id) ||
      !Number.isFinite(instant) ||
      seenInstants.has(instant)
    ) {
      return invalidGrid(
        "The partner availability candidates contain a duplicate or invalid slot.",
      );
    }
    seenIds.add(id);
    seenInstants.add(instant);
    const local = DateTime.fromMillis(instant, { zone: timezone });
    if (!local.isValid || local.second !== 0 || local.millisecond !== 0) {
      return invalidGrid(
        "A partner availability candidate is not on a valid minute boundary.",
      );
    }
    const localDate = local.toISODate();
    if (!localDate) {
      return invalidGrid("A partner availability candidate date is invalid.");
    }
    const entries = candidatesByDate.get(localDate) ?? [];
    entries.push({
      candidate,
      local,
      minuteOfDay: local.hour * 60 + local.minute,
    });
    candidatesByDate.set(localDate, entries);
  }

  const windows: PartnerAvailabilityWindow<T>[] = [];
  for (const [localDate, dateCandidates] of [
    ...candidatesByDate.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    dateCandidates.sort(
      (left, right) =>
        left.candidate.startAt.getTime() - right.candidate.startAt.getTime(),
    );
    const configuredAnchor = options.anchorMinuteByLocalDate?.[localDate];
    const anchorMinute =
      configuredAnchor ??
      Math.min(...dateCandidates.map((entry) => entry.minuteOfDay));
    requireGridMinutes(
      anchorMinute,
      0,
      1439,
      "A partner availability anchor is invalid.",
    );

    const buckets = new Map<number, T[]>();
    for (const entry of dateCandidates) {
      const offset = entry.minuteOfDay - anchorMinute;
      if (offset < 0 || offset % candidateIntervalMinutes !== 0) {
        return invalidGrid(
          "A partner availability candidate is not aligned to its date grid.",
        );
      }
      const bucketIndex = Math.floor(offset / windowMinutes);
      const bucket = buckets.get(bucketIndex) ?? [];
      bucket.push(entry.candidate);
      buckets.set(bucketIndex, bucket);
    }

    for (const [bucketIndex, bucketCandidates] of [...buckets.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const dayStart = DateTime.fromISO(localDate, {
        zone: timezone,
        setZone: true,
      }).startOf("day");
      const localStart = dayStart.plus({
        minutes: anchorMinute + bucketIndex * windowMinutes,
      });
      const localEnd = localStart.plus({ minutes: windowMinutes });
      if (!localStart.isValid || !localEnd.isValid) {
        return invalidGrid("A partner availability window is invalid.");
      }
      const sortedCandidates = Object.freeze(
        [...bucketCandidates].sort(
          (left, right) => left.startAt.getTime() - right.startAt.getTime(),
        ),
      );
      const availableCandidates = Object.freeze(
        sortedCandidates.filter((candidate) => candidate.available),
      );
      const completeGrid = sortedCandidates.length === expectedCandidates;
      const availability: PartnerWindowAvailability =
        availableCandidates.length === 0
          ? "none"
          : completeGrid &&
              availableCandidates.length === sortedCandidates.length
            ? "full"
            : "partial";
      const startAt = localStart.toUTC().toJSDate();
      const endAt = localEnd.toUTC().toJSDate();

      windows.push(
        Object.freeze({
          id: `${localDate}:${localStart.toFormat("HHmm")}`,
          localDate,
          startAt,
          endAt,
          label: labelForWindow(localStart, localEnd),
          availability,
          available: availableCandidates.length > 0,
          completeGrid,
          candidates: sortedCandidates,
          availableCandidates,
        }),
      );
    }
  }

  return Object.freeze(windows);
}

/** The production partner presentation contract: four 30-minute starts/window. */
export function groupThirtyMinutePartnerWindows<
  T extends PartnerWindowCandidate,
>(
  candidates: readonly T[],
  options: {
    timezone: string;
    anchorMinuteByLocalDate?: Readonly<Record<string, number>>;
  },
): readonly PartnerAvailabilityWindow<T>[] {
  return groupPartnerAvailabilityWindows(candidates, {
    ...options,
    candidateIntervalMinutes: 30,
    windowMinutes: 120,
  });
}
