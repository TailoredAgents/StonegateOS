import React from "react";
import { callAdminApi } from "../lib/api";
import { CalendarViewer } from "./CalendarViewer";
import { TEAM_TIME_ZONE } from "../lib/timezone";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  notes?: Array<{ id: string; body: string; createdAt: string }>;
};

type CalendarFeedResponse = {
  ok: boolean;
  appointments: CalendarEvent[];
  externalEvents: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
};

type CalendarStatusApiResponse = {
  ok: boolean;
  config: {
    calendarId: string | null;
    webhookConfigured: boolean;
  };
  status: {
    calendarId: string;
    syncTokenPresent: boolean;
    channelId: string | null;
    resourceId: string | null;
    channelExpiresAt: string | null;
    lastSyncedAt: string | null;
    lastNotificationAt: string | null;
    updatedAt: string | null;
  } | null;
  error?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function CalendarSection({
  searchParams
}: {
  searchParams?: {
    addr?: string;
    city?: string;
    state?: string;
    zip?: string;
    calView?: string;
    cal?: string;
    contactId?: string;
    propertyId?: string;
  };
}): Promise<React.ReactElement> {
  const view = searchParams?.calView === "month" ? "month" : "week";
  const anchor = parseAnchorDate(searchParams?.cal ?? null) ?? new Date();
  const range = computeRange(anchor, view);

  const [feedRes, statusRes] = await Promise.all([
    callAdminApi(`/api/admin/calendar/feed?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`),
    callAdminApi("/api/calendar/status")
  ]);

  if (!feedRes.ok) {
    throw new Error("Failed to load calendar feed");
  }

  const feed = (await feedRes.json()) as CalendarFeedResponse;
  const statusPayload = statusRes.ok ? ((await statusRes.json()) as CalendarStatusApiResponse) : null;
  const allEvents = [...feed.appointments, ...feed.externalEvents];

  return (
    <section className="space-y-4">
      <CalendarViewer
        initialView={view}
        initialAnchor={formatDayKeyFromDate(anchor)}
        events={allEvents}
        conflicts={feed.conflicts}
      />
    </section>
  );
}

function parseAnchorDate(value: string | null): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function formatDayKeyFromDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  if (year && month && day) return `${year}-${month}-${day}`;
  return date.toISOString().slice(0, 10);
}

function getWeekdayIndex(date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TIME_ZONE, weekday: "short" }).format(date);
  switch (weekday.toLowerCase().slice(0, 3)) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      return 0;
  }
}

function getMonthStart(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TIME_ZONE, year: "numeric", month: "2-digit" }).formatToParts(
    date
  );
  const year = Number(parts.find((p) => p.type === "year")?.value ?? "");
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "");
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12, 0, 0, 0));
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0, 0));
}

function computeRange(anchor: Date, view: "week" | "month"): { start: Date; end: Date } {
  const safeAnchor = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  if (view === "week") {
    const weekday = getWeekdayIndex(safeAnchor);
    const start = new Date(safeAnchor.getTime() - weekday * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    return { start, end };
  }

  const monthStart = getMonthStart(safeAnchor);
  const monthStartWeekday = getWeekdayIndex(monthStart);
  const gridStart = new Date(monthStart.getTime() - monthStartWeekday * DAY_MS);
  const gridEnd = new Date(gridStart.getTime() + 42 * DAY_MS);
  return { start: gridStart, end: gridEnd };
}
