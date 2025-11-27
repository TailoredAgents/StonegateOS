import React from "react";
import { callAdminApi } from "../lib/api";
import { BookingAssistant } from "./BookingAssistant";
import { CalendarGrid } from "./CalendarGrid";
import { CalendarMonthGrid } from "./CalendarMonthGrid";

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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function isConflict(conflicts: Array<{ a: string; b: string }>, id: string): boolean {
  return conflicts.some((c) => c.a === id || c.b === id);
}

function evaluateCalendarHealth(payload: CalendarStatusApiResponse): { tone: "ok" | "warn" | "alert" | "idle"; detail: string } {
  if (!payload.ok) return { tone: "alert", detail: payload.error ?? "Status unavailable" };
  if (!payload.config.calendarId) return { tone: "idle", detail: "Calendar ID not set" };
  if (!payload.config.webhookConfigured) return { tone: "warn", detail: "Webhook not configured" };
  if (!payload.status) return { tone: "warn", detail: "Awaiting first sync" };

  const lastSyncedAt = payload.status.lastSyncedAt ? new Date(payload.status.lastSyncedAt) : null;
  const staleSync = !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > 3 * 60 * 60 * 1000;
  if (staleSync) return { tone: "warn", detail: "Sync stale" };
  return { tone: "ok", detail: "Healthy" };
}

export async function CalendarSection({
  searchParams
}: {
  searchParams?: { addr?: string; city?: string; state?: string; zip?: string; view?: string };
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
  const health = statusPayload ? evaluateCalendarHealth(statusPayload) : { tone: "alert", detail: "Status unavailable" };
  const view = searchParams?.view === "month" ? "month" : "week";

  return (
    <section className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Calendar</h2>
            <p className="text-sm text-slate-600">Upcoming appointments with Google Calendar overlay and conflict highlights.</p>
          </div>
          <div
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${
              health.tone === "ok"
                ? "bg-emerald-100 text-emerald-700"
                : health.tone === "warn"
                  ? "bg-amber-100 text-amber-700"
                  : health.tone === "idle"
                    ? "bg-slate-100 text-slate-600"
                    : "bg-rose-100 text-rose-700"
            }`}
          >
            {health.detail}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Appointments</h3>
            <span className="text-xs text-slate-500">{feed.appointments.length} items</span>
          </div>
          <ul className="space-y-3">
            {feed.appointments.map((evt) => (
              <li key={evt.id} className="rounded-lg border border-slate-200 bg-white/80 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{evt.title}</span>
                  {evt.status ? (
                    <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                      {evt.status}
                    </span>
                  ) : null}
                  {isConflict(feed.conflicts, evt.id) ? (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                      Conflict
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-slate-600">{formatTime(evt.start)} – {formatTime(evt.end)}</p>
                {evt.address ? <p className="text-xs text-slate-500">{evt.address}</p> : null}
              </li>
            ))}
            {feed.appointments.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">No appointments in window.</li>
            ) : null}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">Google Calendar</h3>
            <span className="text-xs text-slate-500">{feed.externalEvents.length} items</span>
          </div>
          <ul className="space-y-3">
            {feed.externalEvents.map((evt) => (
              <li key={evt.id} className="rounded-lg border border-slate-200 bg-white/80 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{evt.title}</span>
                  {isConflict(feed.conflicts, evt.id) ? (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-700">
                      Conflict
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-slate-600">{formatTime(evt.start)} – {formatTime(evt.end)}</p>
              </li>
            ))}
            {feed.externalEvents.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">No Google events in window.</li>
            ) : null}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <a
          href="/team?tab=calendar&view=week"
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "week" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Week view
        </a>
        <a
          href="/team?tab=calendar&view=month"
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "month" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Month view
        </a>
      </div>

      <div className="space-y-4">
        {view === "month" ? (
          <CalendarMonthGrid events={[...feed.appointments, ...feed.externalEvents]} conflicts={feed.conflicts} />
        ) : (
          <CalendarGrid events={[...feed.appointments, ...feed.externalEvents]} conflicts={feed.conflicts} />
        )}
      </div>

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
