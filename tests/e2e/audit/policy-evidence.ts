export type QuietHoursChannel = "sms" | "email" | "dm";

export type QuietHoursWindow = {
  end: string;
  start: string;
};

export function readQuietHoursChannel(
  quietHours: Record<string, unknown> | null,
  channel: QuietHoursChannel,
): QuietHoursWindow | null {
  const channels = quietHours?.["channels"];
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return null;
  }
  const value = (channels as Record<string, unknown>)[channel];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const start = (value as Record<string, unknown>)["start"];
  const end = (value as Record<string, unknown>)["end"];
  return typeof start === "string" && typeof end === "string"
    ? { start, end }
    : null;
}
