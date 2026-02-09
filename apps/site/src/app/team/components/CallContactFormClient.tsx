"use client";

import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { startContactCallAction } from "../actions";

export function CallContactFormClient({
  contactId,
  contactName,
  contactPhone,
  canCall,
  className
}: {
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  canCall: boolean;
  className: string;
}): React.ReactElement {
  return (
    <form action={startContactCallAction} method="post" className="inline">
      <input type="hidden" name="contactId" value={contactId} />
      <SubmitButton
        className={className}
        disabled={!canCall}
        pendingLabel="Calling..."
        onClick={(event) => {
          if (!canCall) {
            event.preventDefault();
            return;
          }
          const label = contactPhone ?? "this contact";
          const name = contactName || "this contact";
          if (!window.confirm(`Call ${name} (${label}) from the Stonegate number?`)) {
            event.preventDefault();
          }
        }}
      >
        Call
      </SubmitButton>
    </form>
  );
}

