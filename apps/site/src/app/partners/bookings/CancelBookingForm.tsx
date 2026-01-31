"use client";

import { partnerCancelBookingAction } from "../actions";

export function CancelBookingForm({ appointmentId }: { appointmentId: string }) {
  return (
    <form
      action={partnerCancelBookingAction}
      onSubmit={(event) => {
        if (!confirm("Cancel this booking?")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <button type="submit" className="font-semibold text-rose-700 underline">
        Cancel booking
      </button>
    </form>
  );
}

