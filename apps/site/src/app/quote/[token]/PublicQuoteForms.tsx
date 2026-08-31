"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export type QuoteChangeRequestActionState = {
  ok: boolean | null;
  message: string;
};

const INITIAL_CHANGE_REQUEST_STATE: QuoteChangeRequestActionState = {
  ok: null,
  message: "",
};

const CHANGE_REASONS = [
  "Scope changed",
  "Price question",
  "Timing issue",
  "Address issue",
  "Need to add/remove items",
  "Other",
] as const;

function freshMutationKey(fallback: string): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${fallback}:${Date.now()}`;
}

export function PublicQuoteSubmitButton({
  children,
  className,
  name,
  value,
  pendingLabel,
  trackSelection = false,
}: {
  children: ReactNode;
  className: string;
  name?: string;
  value?: string;
  pendingLabel: string;
  trackSelection?: boolean;
}) {
  const { pending } = useFormStatus();
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    if (!pending) setSelected(false);
  }, [pending]);

  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={className}
      disabled={pending}
      aria-disabled={pending}
      onClick={() => {
        if (trackSelection) setSelected(true);
      }}
    >
      {pending && (!trackSelection || selected) ? pendingLabel : children}
    </button>
  );
}

export function QuoteChangeRequestForm({
  action,
  token,
  quoteId,
  expectedRevision,
  idempotencyKey,
}: {
  action: (formData: FormData) => Promise<QuoteChangeRequestActionState>;
  token: string;
  quoteId: string;
  expectedRevision: number;
  idempotencyKey: string;
}) {
  const [reason, setReason] =
    useState<(typeof CHANGE_REASONS)[number]>("Scope changed");
  const [details, setDetails] = useState("");
  const [mutationKey, setMutationKey] = useState(idempotencyKey);
  const [actionState, formAction, pending] = useActionState(
    async (_state: QuoteChangeRequestActionState, formData: FormData) =>
      action(formData),
    INITIAL_CHANGE_REQUEST_STATE,
  );

  useEffect(() => {
    if (actionState.ok === true) {
      setReason("Scope changed");
      setDetails("");
      setMutationKey(freshMutationKey(idempotencyKey));
    }
  }, [actionState, idempotencyKey]);

  useEffect(() => {
    setMutationKey(idempotencyKey);
  }, [idempotencyKey]);

  const feedbackId = `quote-change-request-feedback-${quoteId}`;
  const detailsHelpId = `quote-change-request-details-help-${quoteId}`;

  return (
    <form
      action={formAction}
      className="mt-5 space-y-4"
      aria-describedby={actionState.ok === null ? undefined : feedbackId}
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <input
        type="hidden"
        name="expectedRevision"
        value={String(expectedRevision)}
      />
      <input type="hidden" name="idempotencyKey" value={mutationKey} />

      <label
        htmlFor={`quote-change-reason-${quoteId}`}
        className="block text-sm font-semibold text-neutral-700"
      >
        What needs to change?
      </label>
      <select
        id={`quote-change-reason-${quoteId}`}
        name="reason"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value as (typeof CHANGE_REASONS)[number]);
          setMutationKey(freshMutationKey(idempotencyKey));
        }}
        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
      >
        {CHANGE_REASONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      <label
        htmlFor={`quote-change-details-${quoteId}`}
        className="block text-sm font-semibold text-neutral-700"
      >
        Details
      </label>
      <textarea
        id={`quote-change-details-${quoteId}`}
        name="message"
        rows={4}
        maxLength={1500}
        value={details}
        onChange={(event) => {
          setDetails(event.target.value);
          setMutationKey(freshMutationKey(idempotencyKey));
        }}
        aria-describedby={detailsHelpId}
        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900 focus-visible:border-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200"
        placeholder="Tell us what should change."
      />
      <p id={detailsHelpId} className="text-xs text-neutral-500">
        Optional, up to 1,500 characters. Your text stays here if sending fails.
      </p>

      {actionState.ok !== null ? (
        <p
          id={feedbackId}
          className={`rounded-xl border p-3 text-sm font-medium ${
            actionState.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-rose-300 bg-rose-50 text-rose-800"
          }`}
          role={actionState.ok ? "status" : "alert"}
          aria-live={actionState.ok ? "polite" : "assertive"}
        >
          {actionState.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        className="min-h-11 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? "Sending request…" : "Send change request"}
      </button>
    </form>
  );
}
