export function readScheduleWarning(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const warning = value as Record<string, unknown>;
  if (
    warning["code"] !== "schedule_capacity_exceeded" ||
    typeof warning["message"] !== "string"
  ) {
    return null;
  }
  return warning["message"].trim() || null;
}
