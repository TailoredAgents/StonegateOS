import {
  DEFAULT_BOOKING_RULES_POLICY,
  DEFAULT_BUSINESS_HOURS_POLICY,
  DEFAULT_COMPANY_PROFILE_POLICY,
  DEFAULT_CONFIRMATION_LOOP_POLICY,
  DEFAULT_CONVERSATION_PERSONA_POLICY,
  DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
  DEFAULT_INBOX_ALERTS_POLICY,
  DEFAULT_ITEM_POLICIES,
  DEFAULT_QUIET_HOURS_POLICY,
  DEFAULT_REVIEW_REQUEST_POLICY,
  DEFAULT_SERVICE_AREA_POLICY,
  DEFAULT_STANDARD_JOB_POLICY,
  DEFAULT_TEMPLATES_POLICY,
} from "../lib/policy";
import {
  EDITABLE_POLICY_KEYS,
  validatePolicyValue,
  type EditablePolicyKey,
} from "../lib/policy-input";

describe("Policy Center input validation", () => {
  const defaults: Record<EditablePolicyKey, Record<string, unknown>> = {
    business_hours: DEFAULT_BUSINESS_HOURS_POLICY,
    quiet_hours: DEFAULT_QUIET_HOURS_POLICY,
    service_area: DEFAULT_SERVICE_AREA_POLICY,
    company_profile: DEFAULT_COMPANY_PROFILE_POLICY,
    conversation_persona: DEFAULT_CONVERSATION_PERSONA_POLICY,
    inbox_alerts: DEFAULT_INBOX_ALERTS_POLICY,
    booking_rules: DEFAULT_BOOKING_RULES_POLICY,
    confirmation_loop: DEFAULT_CONFIRMATION_LOOP_POLICY,
    follow_up_sequence: DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
    standard_job: DEFAULT_STANDARD_JOB_POLICY,
    item_policies: DEFAULT_ITEM_POLICIES,
    review_request: DEFAULT_REVIEW_REQUEST_POLICY,
    templates: DEFAULT_TEMPLATES_POLICY,
  };

  it("accepts every shipped default policy", () => {
    expect(Object.keys(defaults).sort()).toEqual(
      [...EDITABLE_POLICY_KEYS].sort(),
    );

    for (const key of EDITABLE_POLICY_KEYS) {
      expect(validatePolicyValue(key, defaults[key])).toEqual({
        ok: true,
        value: defaults[key],
      });
    }
  });

  it("rejects arrays and malformed structured values with field paths", () => {
    expect(validatePolicyValue("booking_rules", [])).toMatchObject({
      ok: false,
      fieldErrors: { value: "Must be a JSON object." },
    });

    expect(
      validatePolicyValue("booking_rules", {
        bookingWindowDays: 0,
        bufferMinutes: "thirty",
        maxJobsPerDay: 6.5,
        maxJobsPerCrew: 101,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        bookingWindowDays: "Must be at least 1.",
        bufferMinutes: "Must be a finite number.",
        maxJobsPerDay: "Must be a whole number.",
        maxJobsPerCrew: "Must be no more than 100.",
      },
    });

    expect(
      validatePolicyValue("review_request", {
        enabled: true,
        reviewUrl: "javascript:alert(1)",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { reviewUrl: "Must use http or https." },
    });
  });

  it("validates known fields without stripping expert-only fields", () => {
    const advancedValue = {
      ...DEFAULT_BOOKING_RULES_POLICY,
      experimentalCapacityRule: {
        enabled: true,
        label: "Keep this advanced field",
      },
    };

    const result = validatePolicyValue("booking_rules", advancedValue);
    expect(result).toEqual({ ok: true, value: advancedValue });
    if (result.ok) {
      expect(result.value).toBe(advancedValue);
      expect(result.value["experimentalCapacityRule"]).toEqual({
        enabled: true,
        label: "Keep this advanced field",
      });
    }
  });

  it("checks timezone and nested window formats", () => {
    expect(
      validatePolicyValue("business_hours", {
        ...DEFAULT_BUSINESS_HOURS_POLICY,
        timezone: "Not/A_Timezone",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { timezone: "Must be a valid IANA timezone." },
    });

    expect(
      validatePolicyValue("quiet_hours", {
        channels: {
          sms: { start: "25:00", end: "08:00" },
          email: { start: "19:00", end: "07:00" },
          dm: { start: "20:00", end: "08:00" },
        },
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { "channels.sms.start": "Has an invalid format." },
    });
  });
});
