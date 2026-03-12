import { formatDayKey } from "../lib/timezone";

type CalendarAmounts = {
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
};

type CalendarRevenueEvent = CalendarAmounts & {
  source?: "db" | "google";
  start?: string;
  status?: string | null;
  appointmentType?: string | null;
};

export function formatCalendarEventAmounts(event: CalendarAmounts): string | null {
  const parts: string[] = [];
  const quoted = formatUsdCents(event.quotedTotalCents);
  const collected = formatUsdCents(event.finalTotalCents);

  if (quoted) {
    parts.push(`Quoted ${quoted}`);
  }
  if (collected) {
    parts.push(`Collected ${collected}`);
  }

  return parts.length ? parts.join(" / ") : null;
}

export function buildProjectedRevenueByDay(events: CalendarRevenueEvent[]): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const event of events) {
    const cents = getProjectedRevenueCents(event);
    if (cents <= 0) continue;
    if (typeof event.start !== "string" || event.start.trim().length === 0) continue;

    const date = new Date(event.start);
    if (Number.isNaN(date.getTime())) continue;

    const dayKey = formatDayKey(date);
    if (!dayKey) continue;

    totals[dayKey] = (totals[dayKey] ?? 0) + cents;
  }

  return totals;
}

export function formatUsdCents(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  } catch {
    return `$${(value / 100).toFixed(2)}`;
  }
}

export function formatCompactUsdCents(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value / 100);
  } catch {
    return formatUsdCents(value);
  }
}

function getProjectedRevenueCents(event: CalendarRevenueEvent): number {
  if (event.source !== "db") return 0;
  if (isCanceledStatus(event.status)) return 0;
  if (isQuoteOnlyAppointment(event.appointmentType)) return 0;

  return normalizeCents(event.finalTotalCents) ?? normalizeCents(event.quotedTotalCents) ?? 0;
}

function isCanceledStatus(status: string | null | undefined): boolean {
  const normalized = normalizeText(status);
  return normalized === "canceled" || normalized === "cancelled";
}

function isQuoteOnlyAppointment(appointmentType: string | null | undefined): boolean {
  const normalized = normalizeText(appointmentType);
  return normalized === "in_person_quote" || normalized === "in_person_estimate";
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeCents(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}
