import type { PartnerAvailability } from "./portal-v2";

export type PartnerScheduleAssistancePreference =
  | "none"
  | "waitlist"
  | "callback";

export const PARTNER_SCHEDULE_ASSISTANCE_OPTIONS = Object.freeze([
  Object.freeze({
    value: "waitlist" as const,
    label: "Let me know if a matching window opens",
    detail: "Keep this request queued for an opening that fits my choices.",
  }),
  Object.freeze({
    value: "callback" as const,
    label: "Call me about timing",
    detail: "Ask Stonegate to contact me about other scheduling options.",
  }),
  Object.freeze({
    value: "none" as const,
    label: "No extra follow-up",
    detail: "Send the request with my preferred dates for normal review.",
  }),
]);

export function scheduleAssistanceSummary(
  preference: PartnerScheduleAssistancePreference,
): string | null {
  switch (preference) {
    case "waitlist":
      return "Scheduling waitlist requested";
    case "callback":
      return "Scheduling callback requested";
    case "none":
      return null;
  }
}

export function visibleRankedPartnerAlternatives(
  alternatives: PartnerAvailability["rankedAlternatives"] | null | undefined,
  limit = 3,
): PartnerAvailability["rankedAlternatives"] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6) return [];
  const seen = new Set<string>();
  return [...(alternatives ?? [])]
    .filter((window) => {
      if (!window.available || seen.has(window.id)) return false;
      seen.add(window.id);
      return true;
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        Date.parse(left.startAt) - Date.parse(right.startAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}
