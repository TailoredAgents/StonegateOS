"use client";
import { useActionState } from "react";
import { integrationAction } from "./actions";

export function IntegrationControl({
  action,
  id,
  payloadHash,
}: {
  action: "create" | "approve" | "reject" | "revoke" | "enable_individual_sms";
  id?: string;
  payloadHash?: string;
}) {
  const [state, formAction, pending] = useActionState(integrationAction, {
    message: "",
  });
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="id" value={id ?? ""} />
      <input type="hidden" name="payloadHash" value={payloadHash ?? ""} />
      {action === "create" && (
        <label className="block text-sm font-medium">
          Connection name
          <input
            name="name"
            required
            minLength={2}
            maxLength={80}
            defaultValue="Facebook Outreach"
            className="mt-2 block w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-900"
          />
        </label>
      )}
      <button
        disabled={pending}
        className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending
          ? "Saving…"
          : action === "create"
            ? "Create full-access connection"
            : action === "approve"
              ? "Approve this exact action"
              : action === "enable_individual_sms"
                ? "Enable individual promotional SMS"
                : action === "reject"
                  ? "Reject"
                  : "Revoke access"}
      </button>
      {state.message && (
        <p role="status" className="text-sm text-slate-700">
          {state.message}
        </p>
      )}
      {state.token && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="mb-2 text-sm">
            Private connection token · expires in 30 days
          </p>
          <code className="break-all text-xs">{state.token}</code>
        </div>
      )}
    </form>
  );
}
