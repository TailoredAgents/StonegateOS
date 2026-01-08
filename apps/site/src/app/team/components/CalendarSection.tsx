import React from "react";
import { callAdminApi } from "../lib/api";
import { CalendarViewer } from "./CalendarViewer";

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

export async function CalendarSection({
  searchParams
}: {
  searchParams?: { addr?: string; city?: string; state?: string; zip?: string; view?: string; contactId?: string; propertyId?: string };
}): Promise<React.ReactElement> {
  const [feedRes, statusRes] = await Promise.all([
    callAdminApi("/api/admin/calendar/feed"),
    callAdminApi("/api/calendar/status")
  ]);

  if (!feedRes.ok) {
    throw new Error("Failed to load calendar feed");
  }

  const feed = (await feedRes.json()) as CalendarFeedResponse;
  const statusPayload = statusRes.ok ? ((await statusRes.json()) as CalendarStatusApiResponse) : null;
  const view = searchParams?.view === "month" ? "month" : "week";
  const allEvents = [...feed.appointments, ...feed.externalEvents];

  return (
    <section className="space-y-4">
      <CalendarViewer
        initialView={view}
        events={allEvents}
        conflicts={feed.conflicts}
      />
    </section>
  );
}
