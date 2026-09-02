export const PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS = Object.freeze({
  minimumNoticeMinutes: Object.freeze({ minimum: 0, maximum: 10_080 }),
  minimumCalendarLeadDays: Object.freeze({ minimum: 1, maximum: 30 }),
  maximumBookingHorizonDays: Object.freeze({ minimum: 1, maximum: 30 }),
});

export type PartnerAccountSchedulingPolicyValues = Readonly<{
  minimumNoticeMinutes: number;
  minimumCalendarLeadDays: number;
  maximumBookingHorizonDays: number;
  instantConfirmationEnabled: boolean;
}>;

export const DEFAULT_PARTNER_ACCOUNT_SCHEDULING_POLICY: PartnerAccountSchedulingPolicyValues =
  Object.freeze({
    minimumNoticeMinutes: 0,
    minimumCalendarLeadDays: 1,
    maximumBookingHorizonDays: 30,
    // An absent/unreviewed account record must never inherit permission to
    // confirm work merely because every global operational gate is green.
    instantConfirmationEnabled: false,
  });

export type GlobalPartnerSchedulingPolicyValues = Readonly<{
  minimumNoticeMinutes: number;
  minimumCalendarLeadDays: number;
  maximumBookingHorizonDays: number;
  instantConfirmationEnabled: boolean;
}>;

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid Partner scheduling ${field}.`);
  }
  return value;
}

export function validatePartnerAccountSchedulingPolicy(
  value: PartnerAccountSchedulingPolicyValues,
): PartnerAccountSchedulingPolicyValues {
  if (!value || typeof value.instantConfirmationEnabled !== "boolean") {
    throw new TypeError("Invalid Partner account scheduling policy.");
  }
  return Object.freeze({
    minimumNoticeMinutes: boundedInteger(
      value.minimumNoticeMinutes,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.minimumNoticeMinutes.minimum,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.minimumNoticeMinutes.maximum,
      "minimum notice",
    ),
    minimumCalendarLeadDays: boundedInteger(
      value.minimumCalendarLeadDays,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.minimumCalendarLeadDays.minimum,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.minimumCalendarLeadDays.maximum,
      "minimum calendar lead",
    ),
    maximumBookingHorizonDays: boundedInteger(
      value.maximumBookingHorizonDays,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.maximumBookingHorizonDays
        .minimum,
      PARTNER_ACCOUNT_SCHEDULING_POLICY_LIMITS.maximumBookingHorizonDays
        .maximum,
      "maximum horizon",
    ),
    instantConfirmationEnabled: value.instantConfirmationEnabled,
  });
}

/**
 * Resolves the only allowed precedence for account-specific Partner policy.
 * Account values can demand more notice/lead time, a shorter horizon, or turn
 * confirmation off. They cannot open hours, add capacity, or reverse a global
 * restriction because those inputs do not exist in this account contract.
 */
export function narrowGlobalPartnerSchedulingPolicy(input: {
  global: GlobalPartnerSchedulingPolicyValues;
  account: PartnerAccountSchedulingPolicyValues | null;
}): PartnerAccountSchedulingPolicyValues {
  if (
    !input.global ||
    typeof input.global.instantConfirmationEnabled !== "boolean"
  ) {
    throw new TypeError("Invalid global Partner scheduling policy.");
  }
  const global = Object.freeze({
    minimumNoticeMinutes: boundedInteger(
      input.global.minimumNoticeMinutes,
      0,
      365 * 24 * 60,
      "global minimum notice",
    ),
    minimumCalendarLeadDays: boundedInteger(
      input.global.minimumCalendarLeadDays,
      0,
      365,
      "global minimum calendar lead",
    ),
    maximumBookingHorizonDays: boundedInteger(
      input.global.maximumBookingHorizonDays,
      1,
      365,
      "global maximum horizon",
    ),
    instantConfirmationEnabled: input.global.instantConfirmationEnabled,
  });
  const account = validatePartnerAccountSchedulingPolicy(
    input.account ?? DEFAULT_PARTNER_ACCOUNT_SCHEDULING_POLICY,
  );
  return Object.freeze({
    minimumNoticeMinutes: Math.max(
      global.minimumNoticeMinutes,
      account.minimumNoticeMinutes,
    ),
    minimumCalendarLeadDays: Math.max(
      global.minimumCalendarLeadDays,
      account.minimumCalendarLeadDays,
    ),
    maximumBookingHorizonDays: Math.min(
      global.maximumBookingHorizonDays,
      account.maximumBookingHorizonDays,
    ),
    instantConfirmationEnabled:
      global.instantConfirmationEnabled && account.instantConfirmationEnabled,
  });
}
