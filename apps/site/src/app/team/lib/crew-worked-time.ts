import { parseWorkedMinutes } from "./crew-payout-form";

export function decimalHoursToTimeParts(value: string): {
  hours: string;
  minutes: string;
} {
  if (!/^\d+(?:\.\d+)?$/u.test(value.trim())) return { hours: "", minutes: "" };
  const total = Math.round(Number(value) * 60);
  if (!Number.isSafeInteger(total) || total < 0 || total > 525_600) {
    return { hours: "", minutes: "" };
  }
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

// Preserve the existing decimal-hours form contract and its minute rounding.
export function timePartsToDecimalHours(
  hours: string,
  minutes: string,
): string {
  if (!hours.trim() && !minutes.trim()) return "";
  if (![hours, minutes].every((part) => /^\d*$/u.test(part.trim()))) return "";
  const minutePart = Number(minutes);
  const total = Number(hours) * 60 + minutePart;
  if (minutePart > 59 || !Number.isSafeInteger(total) || total > 525_600)
    return "";
  return String(Number((total / 60).toFixed(8)));
}

export function formatCrewWorkedTime(value: string): string {
  const total = parseWorkedMinutes(value);
  if (total === null) return "Time needed";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return [hours ? `${hours} hr` : "", minutes ? `${minutes} min` : ""]
    .filter(Boolean)
    .join(" ");
}
