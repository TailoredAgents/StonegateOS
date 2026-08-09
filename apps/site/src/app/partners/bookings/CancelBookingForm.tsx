"use client";

import { partnerCancelBookingAction } from "../actions";
import { PartnerMutationSubmitButton } from "../PartnerMutationSubmitButton";

export function CancelBookingForm({
  appointmentId,
  version,
  operationKey,
}: {
  appointmentId: string;
  version: number;
  operationKey: string;
}) {
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
      <input type="hidden" name="version" value={String(version)} />
      <input type="hidden" name="operationKey" value={operationKey} />
      <PartnerMutationSubmitButton
        className="min-h-11 font-semibold text-rose-700 underline disabled:cursor-wait disabled:opacity-60"
        pendingLabel="Canceling…"
      >
        Cancel booking
      </PartnerMutationSubmitButton>
    </form>
  );
}
