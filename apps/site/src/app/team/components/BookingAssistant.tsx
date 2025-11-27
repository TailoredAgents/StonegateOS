import React from "react";
import { callAdminApi } from "../lib/api";

type Suggestion = {
  startAt: string;
  endAt: string;
  reason: string;
};

type Props = {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  contactId?: string | null;
  propertyId?: string | null;
};

export async function BookingAssistant(props: Props): Promise<React.ReactElement> {
  const payload: Record<string, unknown> = {};
  if (props.addressLine1) payload["addressLine1"] = props.addressLine1;
  if (props.city) payload["city"] = props.city;
  if (props.state) payload["state"] = props.state;
  if (props.postalCode) payload["postalCode"] = props.postalCode;
  if (props.contactId) payload["contactId"] = props.contactId;
  if (props.propertyId) payload["propertyId"] = props.propertyId;

  const res = await callAdminApi("/api/admin/booking/assist", {
    method: "POST",
    body: JSON.stringify(payload)
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
            <li key={slot.startAt} className="rounded-lg border border-slate-200 bg-white/80 p-3 space-y-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {fmt(slot.startAt)} – {fmt(slot.endAt)}
                </p>
                <p className="text-xs text-slate-500">{slot.reason}</p>
              </div>
              <form
                action="/api/admin/booking/book"
                method="post"
                className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs"
              >
                <input type="hidden" name="startAt" value={slot.startAt} />
                <input type="hidden" name="durationMinutes" value="60" />
                <input type="hidden" name="travelBufferMinutes" value="30" />
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-slate-700">Contact ID</span>
                  <input
                    name="contactId"
                    defaultValue={props.contactId ?? ""}
                    required
                    className="rounded border border-slate-200 px-2 py-1"
                    placeholder="Contact ID"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-slate-700">Property ID</span>
                  <input
                    name="propertyId"
                    defaultValue={props.propertyId ?? ""}
                    required
                    className="rounded border border-slate-200 px-2 py-1"
                    placeholder="Property ID"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-slate-700">Services (comma separated)</span>
                  <input
                    name="services"
                    className="rounded border border-slate-200 px-2 py-1"
                    placeholder="e.g. furniture, appliances"
                  />
                </label>
                <button
                  type="submit"
                  className="mt-1 rounded bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700"
                >
                  Book this slot
                </button>
              </form>
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
