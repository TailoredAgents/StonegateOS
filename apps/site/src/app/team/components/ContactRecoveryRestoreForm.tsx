"use client";

import { SubmitButton } from "@/components/SubmitButton";
import { restoreContactAction } from "../actions";
import { teamButtonClass } from "./team-ui";

export function ContactRecoveryRestoreForm({
  contactId,
  contactName,
  expectedVersion,
}: {
  contactId: string;
  contactName: string;
  expectedVersion: string;
}) {
  return (
    <form
      action={restoreContactAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Restore ${contactName}? Automation and quarantined operations will remain paused for owner review.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="contactId" value={contactId} />
      <input
        type="hidden"
        name="expectedVersion"
        value={expectedVersion}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={`contact-restore:${contactId}:${expectedVersion}`}
      />
      <SubmitButton
        className={teamButtonClass("primary", "sm")}
        pendingLabel="Restoring..."
      >
        Restore contact
      </SubmitButton>
    </form>
  );
}
