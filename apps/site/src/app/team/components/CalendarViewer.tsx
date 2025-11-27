"use client";

import React from "react";
import { CalendarGrid, type CalendarEvent } from "./CalendarGrid";
import { CalendarMonthGrid } from "./CalendarMonthGrid";
import { CalendarEventDetail } from "./CalendarEventDetail";
import { BookingAssistant } from "./BookingAssistant";

type Props = {
  initialView: "week" | "month";
  events: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  bookingAddress: {
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    contactId?: string;
    propertyId?: string;
  };
};

export function CalendarViewer({ initialView, events, conflicts, bookingAddress }: Props) {
  const [view, setView] = React.useState<"week" | "month">(initialView);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selectedEvent = selectedId ? events.find((evt) => evt.id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setView("week")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "week" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Week view
        </button>
        <button
          type="button"
          onClick={() => setView("month")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            view === "month" ? "bg-primary-600 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          Month view
        </button>
      </div>

      {view === "month" ? (
        <CalendarMonthGrid events={events} conflicts={conflicts} onSelectEvent={setSelectedId} />
      ) : (
        <CalendarGrid events={events} conflicts={conflicts} onSelectEvent={setSelectedId} />
      )}

      {selectedEvent ? <CalendarEventDetail event={selectedEvent} /> : null}

      <BookingAssistant
        addressLine1={bookingAddress.addressLine1}
        city={bookingAddress.city}
        state={bookingAddress.state}
        postalCode={bookingAddress.postalCode}
        contactId={bookingAddress.contactId}
        propertyId={bookingAddress.propertyId}
      />
    </div>
  );
}
