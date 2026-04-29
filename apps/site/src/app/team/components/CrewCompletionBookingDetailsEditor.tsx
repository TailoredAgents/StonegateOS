"use client";

import React from "react";
import type { AppointmentBookingDetails } from "../lib/booking-details";
import { AppointmentBookingDetailsFields } from "./AppointmentBookingDetailsFields";

type TeamMember = {
  id: string;
  name: string;
};

type Props = {
  teamMembers: TeamMember[];
  bookingDetails: AppointmentBookingDetails | null;
  quotedTotalCents: number | null;
};

export function CrewCompletionBookingDetailsEditor({
  teamMembers,
  bookingDetails,
  quotedTotalCents,
}: Props): React.ReactElement {
  const [enabled, setEnabled] = React.useState(false);

  return (
    <details className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
      <summary className="cursor-pointer select-none font-medium">
        Quote and job size
      </summary>
      <div className="mt-3 space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm">
          <input
            type="checkbox"
            name="updateBookingDetails"
            value="1"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="block font-semibold text-slate-900">
              Update quote or job size before completing
            </span>
            <span className="mt-1 block text-xs leading-5 text-slate-600">
              Use this if the actual job size or quote changed in the field.
            </span>
          </span>
        </label>

        <fieldset
          disabled={!enabled}
          className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${
            enabled ? "" : "opacity-50"
          }`}
        >
          <AppointmentBookingDetailsFields
            teamMembers={teamMembers}
            bookingDetails={bookingDetails}
            quotedTotalCents={quotedTotalCents}
            allowServiceTypeSelection
            labelClassName="flex flex-col gap-1"
            fieldClassName="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          />
        </fieldset>
      </div>
    </details>
  );
}
