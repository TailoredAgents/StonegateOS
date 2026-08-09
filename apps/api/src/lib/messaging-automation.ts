export const MESSAGING_AUTOMATION_PUBLIC_MODES = [
  "off",
  "assist",
  "automatic",
] as const;

export type MessagingAutomationMode =
  (typeof MESSAGING_AUTOMATION_PUBLIC_MODES)[number];
export type StoredSalesAutopilotMode = "off" | "partial" | "full";
export type StoredLegacyAutomationMode = "draft" | "assist" | "auto";

export const MESSAGING_AUTOMATION_PRECEDENCE = [
  "Do Not Contact",
  "Human takeover or pause",
  "Quiet hours or sending cap",
  "Channel override",
  "Global mode",
] as const;

export type MessagingAutomationPrecedenceReason =
  | "dnc"
  | "human_takeover"
  | "paused"
  | "quiet_hours"
  | "cap_reached"
  | "emergency_stop"
  | "channel_override"
  | "global_mode";

export type MessagingAutomationDecision =
  | "blocked"
  | "approval_required"
  | "automatic";

export type MessagingAutomationPrecedenceResult = {
  effectiveMode: MessagingAutomationMode;
  decision: MessagingAutomationDecision;
  automaticSendAllowed: boolean;
  reason: MessagingAutomationPrecedenceReason;
  explanation: string;
};

export function normalizeMessagingAutomationMode(
  value: unknown,
): MessagingAutomationMode | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "off":
    case "draft":
      return "off";
    case "assist":
    case "partial":
      return "assist";
    case "automatic":
    case "auto":
    case "full":
      return "automatic";
    default:
      return null;
  }
}

export function toStoredSalesAutopilotMode(
  mode: MessagingAutomationMode,
): StoredSalesAutopilotMode {
  if (mode === "assist") return "partial";
  if (mode === "automatic") return "full";
  return "off";
}

export function toStoredLegacyAutomationMode(
  mode: MessagingAutomationMode,
): StoredLegacyAutomationMode {
  if (mode === "assist") return "assist";
  if (mode === "automatic") return "auto";
  return "draft";
}

function resultForMode(
  mode: MessagingAutomationMode,
  reason: "channel_override" | "global_mode",
): MessagingAutomationPrecedenceResult {
  if (mode === "automatic") {
    return {
      effectiveMode: mode,
      decision: "automatic",
      automaticSendAllowed: true,
      reason,
      explanation:
        reason === "channel_override"
          ? "The channel override allows automatic handling."
          : "The global mode allows automatic handling.",
    };
  }
  if (mode === "assist") {
    return {
      effectiveMode: mode,
      decision: "approval_required",
      automaticSendAllowed: false,
      reason,
      explanation:
        reason === "channel_override"
          ? "The channel override requires a person to approve the action."
          : "The global mode requires a person to approve the action.",
    };
  }
  return {
    effectiveMode: mode,
    decision: "blocked",
    automaticSendAllowed: false,
    reason,
    explanation:
      reason === "channel_override"
        ? "The channel override turns automation off."
        : "The global mode turns automation off.",
  };
}

/**
 * Resolves the one public automation model in its fixed safety order.
 * The first matching guard wins; later settings can never bypass it.
 */
export function evaluateMessagingAutomationPrecedence(input: {
  dnc?: boolean;
  humanTakeover?: boolean;
  paused?: boolean;
  quietHoursActive?: boolean;
  capReached?: boolean;
  emergencyStop?: boolean;
  channelOverride?: MessagingAutomationMode | null;
  globalMode: MessagingAutomationMode;
}): MessagingAutomationPrecedenceResult {
  if (input.dnc === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "dnc",
      explanation: "Do Not Contact blocks automated outreach.",
    };
  }
  if (input.humanTakeover === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "human_takeover",
      explanation: "A person has taken over this conversation.",
    };
  }
  if (input.paused === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "paused",
      explanation: "Automation is paused for this lead and channel.",
    };
  }
  if (input.quietHoursActive === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "quiet_hours",
      explanation: "Quiet hours defer automated outreach.",
    };
  }
  if (input.capReached === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "cap_reached",
      explanation: "The configured sending cap has been reached.",
    };
  }
  if (input.emergencyStop === true) {
    return {
      effectiveMode: "off",
      decision: "blocked",
      automaticSendAllowed: false,
      reason: "emergency_stop",
      explanation: "The global emergency stop is active.",
    };
  }
  if (input.channelOverride) {
    return resultForMode(input.channelOverride, "channel_override");
  }
  return resultForMode(input.globalMode, "global_mode");
}
