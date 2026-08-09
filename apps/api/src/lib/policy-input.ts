const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const ZIP_PATTERN = /^\d{5}$/u;

export const EDITABLE_POLICY_KEYS = [
  "business_hours",
  "quiet_hours",
  "service_area",
  "company_profile",
  "conversation_persona",
  "inbox_alerts",
  "booking_rules",
  "confirmation_loop",
  "follow_up_sequence",
  "standard_job",
  "item_policies",
  "review_request",
  "templates",
] as const;

export type EditablePolicyKey = (typeof EDITABLE_POLICY_KEYS)[number];

export type PolicyValueValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      message: string;
      fieldErrors: Record<string, string>;
    };

type ValidationErrors = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(
  errors: ValidationErrors,
  path: string,
  message: string,
): void {
  if (!(path in errors)) {
    errors[path] = message;
  }
}

function requireRecord(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    addError(errors, path, "Must be an object.");
    return null;
  }
  return value;
}

function validateString(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  options: { required?: boolean; max?: number; pattern?: RegExp } = {},
): void {
  if (value === undefined && !options.required) return;
  if (typeof value !== "string") {
    addError(errors, path, "Must be text.");
    return;
  }
  if (options.required && value.trim().length === 0) {
    addError(errors, path, "Is required.");
    return;
  }
  if (options.max !== undefined && value.length > options.max) {
    addError(errors, path, `Must be ${options.max} characters or fewer.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    addError(errors, path, "Has an invalid format.");
  }
}

function validateBoolean(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  required = true,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "boolean") {
    addError(errors, path, "Must be true or false.");
  }
}

function validateNumber(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  options: {
    required?: boolean;
    integer?: boolean;
    min?: number;
    max?: number;
  } = {},
): void {
  if (value === undefined && !options.required) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addError(errors, path, "Must be a finite number.");
    return;
  }
  if (options.integer && !Number.isInteger(value)) {
    addError(errors, path, "Must be a whole number.");
  }
  if (options.min !== undefined && value < options.min) {
    addError(errors, path, `Must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    addError(errors, path, `Must be no more than ${options.max}.`);
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  options: {
    required?: boolean;
    min?: number;
    max?: number;
    itemMax?: number;
    pattern?: RegExp;
  } = {},
): void {
  if (value === undefined && !options.required) return;
  if (!Array.isArray(value)) {
    addError(errors, path, "Must be a list.");
    return;
  }
  if (options.min !== undefined && value.length < options.min) {
    addError(errors, path, `Must contain at least ${options.min} item.`);
  }
  if (options.max !== undefined && value.length > options.max) {
    addError(errors, path, `Must contain no more than ${options.max} items.`);
  }
  value.forEach((entry, index) => {
    validateString(entry, `${path}.${index}`, errors, {
      required: true,
      max: options.itemMax,
      pattern: options.pattern,
    });
  });
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validateTimeWindow(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): void {
  const window = requireRecord(value, path, errors);
  if (!window) return;
  validateString(window["start"], `${path}.start`, errors, {
    required: true,
    pattern: TIME_PATTERN,
  });
  validateString(window["end"], `${path}.end`, errors, {
    required: true,
    pattern: TIME_PATTERN,
  });
}

function validateBusinessHours(
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  validateString(value["timezone"], "timezone", errors, {
    required: true,
    max: 100,
  });
  if (
    typeof value["timezone"] === "string" &&
    !isValidTimeZone(value["timezone"])
  ) {
    addError(errors, "timezone", "Must be a valid IANA timezone.");
  }
  const weekly = requireRecord(value["weekly"], "weekly", errors);
  if (!weekly) return;
  for (const day of [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]) {
    const windows = weekly[day];
    if (!Array.isArray(windows)) {
      addError(errors, `weekly.${day}`, "Must be a list of time windows.");
      continue;
    }
    if (windows.length > 4) {
      addError(errors, `weekly.${day}`, "Supports no more than four windows.");
    }
    windows.forEach((window, index) =>
      validateTimeWindow(window, `weekly.${day}.${index}`, errors),
    );
  }
}

function validateQuietHours(
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  const channels = requireRecord(value["channels"], "channels", errors);
  if (!channels) return;
  for (const channel of ["sms", "email", "dm"]) {
    validateTimeWindow(channels[channel], `channels.${channel}`, errors);
  }
}

function validateServiceArea(
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  if (
    value["mode"] !== "zip_allowlist" &&
    value["mode"] !== "ga_only" &&
    value["mode"] !== "ga_above_macon"
  ) {
    addError(errors, "mode", "Must be a supported service-area mode.");
  }
  validateString(value["homeBase"], "homeBase", errors, { max: 200 });
  validateNumber(value["radiusMiles"], "radiusMiles", errors, {
    min: 0,
    max: 500,
  });
  validateStringArray(value["zipAllowlist"], "zipAllowlist", errors, {
    required: true,
    max: 2_000,
    itemMax: 5,
    pattern: ZIP_PATTERN,
  });
  validateStringArray(value["cityAllowlist"], "cityAllowlist", errors, {
    required: true,
    max: 500,
    itemMax: 120,
  });
  validateString(value["notes"], "notes", errors, { max: 2_000 });
}

function validateCompanyProfile(
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  validateString(value["businessName"], "businessName", errors, {
    required: true,
    max: 200,
  });
  validateString(value["primaryPhone"], "primaryPhone", errors, { max: 50 });
  validateNumber(value["discountPercent"], "discountPercent", errors, {
    min: 0,
    max: 0.9,
  });
  for (const field of [
    "serviceAreaSummary",
    "trailerAndPricingSummary",
    "whatWeDo",
    "whatWeDontDo",
    "bookingStyle",
    "agentNotes",
    "outboundCallRecordingNotice",
  ]) {
    validateString(value[field], field, errors, { max: 4_000 });
  }
}

function validateTemplates(
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  for (const groupName of [
    "first_touch",
    "follow_up",
    "confirmations",
    "reviews",
    "out_of_area",
  ]) {
    const group = requireRecord(value[groupName], groupName, errors);
    if (!group) continue;
    if (Object.keys(group).length > 20) {
      addError(errors, groupName, "Supports no more than 20 channel entries.");
    }
    for (const [channel, template] of Object.entries(group)) {
      validateString(template, `${groupName}.${channel}`, errors, {
        required: true,
        max: 8_000,
      });
    }
  }
}

function validatePolicyFields(
  key: EditablePolicyKey,
  value: Record<string, unknown>,
  errors: ValidationErrors,
): void {
  switch (key) {
    case "business_hours":
      validateBusinessHours(value, errors);
      return;
    case "quiet_hours":
      validateQuietHours(value, errors);
      return;
    case "service_area":
      validateServiceArea(value, errors);
      return;
    case "company_profile":
      validateCompanyProfile(value, errors);
      return;
    case "conversation_persona":
      validateString(value["systemPrompt"], "systemPrompt", errors, {
        required: true,
        max: 4_000,
      });
      return;
    case "inbox_alerts":
      for (const channel of ["sms", "dm", "email"]) {
        validateBoolean(value[channel], channel, errors);
      }
      return;
    case "booking_rules":
      validateNumber(value["bookingWindowDays"], "bookingWindowDays", errors, {
        required: true,
        integer: true,
        min: 1,
        max: 365,
      });
      validateNumber(value["bufferMinutes"], "bufferMinutes", errors, {
        required: true,
        integer: true,
        min: 0,
        max: 1_440,
      });
      validateNumber(value["maxJobsPerDay"], "maxJobsPerDay", errors, {
        required: true,
        integer: true,
        min: 0,
        max: 100,
      });
      validateNumber(value["maxJobsPerCrew"], "maxJobsPerCrew", errors, {
        required: true,
        integer: true,
        min: 0,
        max: 100,
      });
      return;
    case "confirmation_loop":
    case "follow_up_sequence": {
      validateBoolean(value["enabled"], "enabled", errors);
      const field =
        key === "confirmation_loop" ? "windowsMinutes" : "stepsMinutes";
      const entries = value[field];
      if (!Array.isArray(entries)) {
        addError(errors, field, "Must be a list of minute values.");
        return;
      }
      if (entries.length > 20) {
        addError(errors, field, "Supports no more than 20 entries.");
      }
      entries.forEach((entry, index) =>
        validateNumber(entry, `${field}.${index}`, errors, {
          required: true,
          integer: true,
          min: 1,
          max: 525_600,
        }),
      );
      return;
    }
    case "standard_job":
      validateStringArray(value["allowedServices"], "allowedServices", errors, {
        required: true,
        min: 1,
        max: 100,
        itemMax: 200,
      });
      validateNumber(
        value["maxVolumeCubicYards"],
        "maxVolumeCubicYards",
        errors,
        { required: true, min: 0, max: 10_000 },
      );
      validateNumber(value["maxItemCount"], "maxItemCount", errors, {
        required: true,
        integer: true,
        min: 0,
        max: 100_000,
      });
      validateString(value["notes"], "notes", errors, { max: 4_000 });
      return;
    case "item_policies": {
      validateStringArray(value["declined"], "declined", errors, {
        required: true,
        max: 500,
        itemMax: 200,
      });
      const fees = value["extraFees"];
      if (!Array.isArray(fees)) {
        addError(errors, "extraFees", "Must be a list.");
        return;
      }
      if (fees.length > 500) {
        addError(errors, "extraFees", "Supports no more than 500 fees.");
      }
      fees.forEach((entry, index) => {
        const fee = requireRecord(entry, `extraFees.${index}`, errors);
        if (!fee) return;
        validateString(fee["item"], `extraFees.${index}.item`, errors, {
          required: true,
          max: 200,
        });
        validateNumber(fee["fee"], `extraFees.${index}.fee`, errors, {
          required: true,
          min: 0,
          max: 1_000_000,
        });
      });
      return;
    }
    case "review_request": {
      validateBoolean(value["enabled"], "enabled", errors);
      validateString(value["reviewUrl"], "reviewUrl", errors, {
        required: true,
        max: 2_048,
      });
      if (typeof value["reviewUrl"] === "string") {
        try {
          const url = new URL(value["reviewUrl"]);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            addError(errors, "reviewUrl", "Must use http or https.");
          }
        } catch {
          addError(errors, "reviewUrl", "Must be a valid URL.");
        }
      }
      return;
    }
    case "templates":
      validateTemplates(value, errors);
  }
}

export function isEditablePolicyKey(value: string): value is EditablePolicyKey {
  return (EDITABLE_POLICY_KEYS as readonly string[]).includes(value);
}

export function validatePolicyValue(
  key: EditablePolicyKey,
  value: unknown,
): PolicyValueValidationResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      message: "Policy value must be a JSON object.",
      fieldErrors: { value: "Must be a JSON object." },
    };
  }

  const fieldErrors: ValidationErrors = {};
  validatePolicyFields(key, value, fieldErrors);
  const firstError = Object.entries(fieldErrors)[0];
  if (firstError) {
    return {
      ok: false,
      message: `${firstError[0]}: ${firstError[1]}`,
      fieldErrors,
    };
  }

  // Validation deliberately returns the original object. Expert-only fields
  // are accepted and retained instead of being stripped by a schema parser.
  return { ok: true, value };
}
