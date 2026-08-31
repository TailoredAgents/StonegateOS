import type { PartnerServiceKey } from "@myst-os/pricing";

export const SCHEDULING_CHANNELS = [
  "partner_portal",
  "public_quote",
  "instant_quote",
  "staff",
  "autonomous",
] as const;

export type SchedulingChannel = (typeof SCHEDULING_CHANNELS)[number];
export type SchedulingServiceKey = PartnerServiceKey;

export const SCHEDULING_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type SchedulingWeekday = (typeof SCHEDULING_WEEKDAYS)[number];

export type LocalMinuteWindow = Readonly<{
  /** Inclusive local minute after midnight. */
  startMinute: number;
  /** Exclusive local minute after midnight; 1440 represents midnight. */
  endMinute: number;
}>;

export type ScheduleCapacityPool = Readonly<{
  key: string;
  capacityUnits: number;
}>;

export type ScheduleChannelPolicy = Readonly<{
  minimumNoticeMinutes: number;
  minimumCalendarLeadDays: number;
  allowsInstantConfirmation: boolean;
}>;

export type ScheduleDateOverride = Readonly<{
  localDate: string;
  closed: boolean;
  windows?: readonly LocalMinuteWindow[];
  capacityByPool?: Readonly<Record<string, number>>;
}>;

export type SchedulePolicySnapshot = Readonly<{
  revision: string;
  timezone: string;
  slotIntervalMinutes: number;
  partnerWindowMinutes: number;
  holdTtlMinutes: number;
  bookingWindowDays: number;
  defaultTravelBufferMinutes: number;
  maxJobsPerDay: number;
  weeklyHours: Readonly<
    Record<SchedulingWeekday, readonly LocalMinuteWindow[]>
  >;
  dateOverrides: readonly ScheduleDateOverride[];
  capacityPools: Readonly<Record<string, ScheduleCapacityPool>>;
  channels: Readonly<Record<SchedulingChannel, ScheduleChannelPolicy>>;
}>;

export type ScheduleDemand = Readonly<{
  serviceKey: SchedulingServiceKey;
  durationMinutes: number;
  travelBufferMinutes: number;
  capacityPoolKey: string;
  capacityUnits: number;
  allowsInstantConfirmation: boolean;
}>;

export type ScheduleInterval = Readonly<{
  startAt: Date;
  endAt: Date;
}>;

export type ScheduleOccupancy = Readonly<{
  work: ScheduleInterval;
  occupancy: ScheduleInterval;
  durationMinutes: number;
  travelBufferMinutes: number;
}>;

export type ScheduleCapacityBlockKind =
  | "appointment"
  | "hold"
  | "blackout"
  | "external_busy";

export type ScheduleCapacityBlock = Readonly<{
  id: string;
  kind: ScheduleCapacityBlockKind;
  capacityPoolKey: string;
  capacityUnits: number;
  occupancy: ScheduleInterval;
}>;

export type ScheduleCandidateSlot = Readonly<{
  id: string;
  startAt: Date;
  workEndAt: Date;
  occupancyEndAt: Date;
  available: boolean;
}>;
