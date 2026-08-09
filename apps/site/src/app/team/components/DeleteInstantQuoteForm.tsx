"use client";

import { SubmitButton } from "@/components/SubmitButton";

type ServerAction = (formData: FormData) => void | Promise<void>;

export function DeleteInstantQuoteForm({
  instantQuoteId,
  expectedVersion,
  idempotencyKey,
  action,
}: {
  instantQuoteId: string;
  expectedVersion: string;
  idempotencyKey: string;
  action: ServerAction;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm("Delete this instant quote? This cannot be undone.")
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="instantQuoteId" value={instantQuoteId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <SubmitButton
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-slate-300"
        pendingLabel="Deleting..."
      >
        Delete
      </SubmitButton>
    </form>
  );
}
