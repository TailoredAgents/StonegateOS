import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  approveMergeSuggestionAction,
  declineMergeSuggestionAction,
  manualMergeContactsAction,
  scanMergeSuggestionsAction
} from "../actions";

type ContactSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

type MergeSuggestion = {
  id: string;
  status: string;
  reason: string;
  confidence: number;
  createdAt: string;
  sourceContact: ContactSummary | null;
  targetContact: ContactSummary | null;
  meta?: Record<string, unknown> | null;
};

function formatReason(value: string): string {
  return value.replace(/_/g, " ");
}

export async function MergeQueueSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/merge-suggestions?status=pending&limit=50");
  if (!response.ok) {
    throw new Error("Failed to load merge queue");
  }

  const payload = (await response.json()) as { suggestions?: MergeSuggestion[] };
  const suggestions = payload.suggestions ?? [];

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Merge Queue</h2>
        <p className="mt-1 text-sm text-slate-600">
          Review possible duplicate contacts and approve merges when the match looks confident.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <form action={scanMergeSuggestionsAction}>
            <SubmitButton
              className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
              pendingLabel="Scanning..."
            >
              Scan for matches
            </SubmitButton>
          </form>
          <span className="text-xs text-slate-500">{suggestions.length} pending matches</span>
        </div>
      </header>

      <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
        <h3 className="text-base font-semibold text-slate-900">Manual merge</h3>
        <p className="text-xs text-slate-500">
          Use this when you already know the primary contact and the duplicate.
        </p>
        <form action={manualMergeContactsAction} className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span>Primary contact ID</span>
            <input
              name="targetContactId"
              placeholder="Contact UUID"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Duplicate contact ID</span>
            <input
              name="sourceContactId"
              placeholder="Contact UUID"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Reason (optional)</span>
            <input
              name="reason"
              placeholder="address match"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <div className="sm:col-span-3">
            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Merging..."
            >
              Merge contacts
            </SubmitButton>
          </div>
        </form>
      </div>

      {suggestions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 p-5 text-sm text-slate-500 shadow-sm">
          No pending merge suggestions right now.
        </div>
      ) : (
        <div className="space-y-4">
          {suggestions.map((suggestion) => {
            const primary = suggestion.targetContact;
            const duplicate = suggestion.sourceContact;
            const metaAddress = suggestion.meta ? String(suggestion.meta["addressLine1"] ?? "") : "";
            const metaCity = suggestion.meta ? String(suggestion.meta["city"] ?? "") : "";
            const metaState = suggestion.meta ? String(suggestion.meta["state"] ?? "") : "";
            const metaPostal = suggestion.meta ? String(suggestion.meta["postalCode"] ?? "") : "";
            const addressLine = [metaAddress, metaCity, metaState, metaPostal].filter((value) => value.length > 0).join(", ");

            return (
              <div
                key={suggestion.id}
                className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/40 backdrop-blur"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="text-base font-semibold text-slate-900">Potential duplicate</h4>
                    <p className="text-xs text-slate-500">
                      {formatReason(suggestion.reason)} - Confidence {suggestion.confidence}%
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                    Pending
                  </span>
                </div>

                {addressLine ? (
                  <div className="mt-2 text-xs text-slate-500">Address match: {addressLine}</div>
                ) : null}

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/70 p-4 text-sm text-emerald-900">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Primary</p>
                    <p className="mt-2 text-base font-semibold">{primary?.name ?? "Unknown"}</p>
                    <p className="mt-1 text-xs text-emerald-700">{primary?.email ?? "No email"}</p>
                    <p className="text-xs text-emerald-700">{primary?.phone ?? "No phone"}</p>
                    <p className="mt-2 text-[11px] text-emerald-700">ID: {primary?.id ?? "unknown"}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Duplicate</p>
                    <p className="mt-2 text-base font-semibold text-slate-900">{duplicate?.name ?? "Unknown"}</p>
                    <p className="mt-1 text-xs text-slate-500">{duplicate?.email ?? "No email"}</p>
                    <p className="text-xs text-slate-500">{duplicate?.phone ?? "No phone"}</p>
                    <p className="mt-2 text-[11px] text-slate-500">ID: {duplicate?.id ?? "unknown"}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                  <form action={approveMergeSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <SubmitButton
                      className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                      pendingLabel="Merging..."
                    >
                      Approve merge
                    </SubmitButton>
                  </form>
                  <form action={declineMergeSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <SubmitButton
                      className="rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
                      pendingLabel="Declining..."
                    >
                      Decline
                    </SubmitButton>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
