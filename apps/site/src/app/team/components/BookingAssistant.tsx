import React from "react";
import { callAdminApi } from "../lib/api";

type Suggestion = {
  startAt: string;
  endAt: string;
  reason: string;
};

export async function BookingAssistant(): Promise<React.ReactElement> {
  const res = await callAdminApi("/api/admin/booking/assist", {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!res.ok) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        Unable to fetch booking suggestions.
      </div>
    );
  }

  const data = (await res.json()) as { ok: boolean; suggestions: Suggestion[] };
  const suggestions = data.suggestions ?? [];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-lg shadow-slate-200/50">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">Booking assistant</h3>
        <span className="text-xs text-slate-500">Next 5 days</span>
      </div>
      {suggestions.length === 0 ? (
        <p className="text-sm text-slate-500">No open slots found. Adjust hours or window.</p>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((slot) => (
            <li key={slot.startAt} className="rounded-lg border border-slate-200 bg-white/80 p-3">
              <p className="text-sm font-semibold text-slate-900">
                {fmt(slot.startAt)} – {fmt(slot.endAt)}
              </p>
              <p className="text-xs text-slate-500">{slot.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}
