import React from "react";
import { callAdminApi } from "../lib/api";
import { BookingAssistant } from "./BookingAssistant";
import { CalendarViewer } from "./CalendarViewer";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
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

      <div className="grid gap-4 lg:grid-cols-2">
        <BookingAssistant
          addressLine1={searchParams?.addr ?? undefined}
          city={searchParams?.city ?? undefined}
          state={searchParams?.state ?? undefined}
          postalCode={searchParams?.zip ?? undefined}
        />

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
          <h3 className="text-base font-semibold text-slate-900">Target address (optional)</h3>
          <form method="get" action="/team" className="mt-2 space-y-2">
            <input type="hidden" name="tab" value="calendar" />
            <label className="block text-sm text-slate-700">
              Address
              <input
                name="addr"
                defaultValue={searchParams?.addr ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="123 Main St"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-2 block text-sm text-slate-700">
                City
                <input
                  name="city"
                  defaultValue={searchParams?.city ?? ""}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Roswell"
                />
              </label>
              <label className="block text-sm text-slate-700">
                State
                <input
                  name="state"
                  defaultValue={searchParams?.state ?? ""}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  placeholder="GA"
                  maxLength={2}
                />
              </label>
            </div>
            <label className="block text-sm text-slate-700">
              ZIP
              <input
                name="zip"
                defaultValue={searchParams?.zip ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="30075"
              />
            </label>
            <label className="block text-sm text-slate-700">
              Contact ID
              <input
                name="contactId"
                defaultValue={searchParams?.contactId ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="Contact ID"
              />
            </label>
            <label className="block text-sm text-slate-700">
              Property ID
              <input
                name="propertyId"
                defaultValue={searchParams?.propertyId ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                placeholder="Property ID"
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              Refresh suggestions
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
