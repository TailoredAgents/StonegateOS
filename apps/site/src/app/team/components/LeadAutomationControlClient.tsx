"use client";

import React, { useMemo, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";

type LeadAutomationState = {
  channel: string;
  paused: boolean;
  dnc: boolean;
  humanTakeover: boolean;
  followupState: string | null;
  followupStep: number;
  nextFollowupAt: string | null;
};

type AutomationLead = {
  id: string;
  contactId: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
  automationStates: LeadAutomationState[];
};

type EditableState = {
  paused: boolean;
  dnc: boolean;
  humanTakeover: boolean;
  followupState: string;
  followupStep: number;
  nextFollowupAt: string;
};

const EMPTY_STATE: EditableState = {
  paused: false,
  dnc: false,
  humanTakeover: false,
  followupState: "",
  followupStep: 0,
  nextFollowupAt: "",
};

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function stateForLead(
  lead: AutomationLead,
  channel: string,
): EditableState {
  const state = lead.automationStates.find(
    (candidate) => candidate.channel === channel,
  );
  return state
    ? {
        paused: state.paused,
        dnc: state.dnc,
        humanTakeover: state.humanTakeover,
        followupState: state.followupState ?? "",
        followupStep: state.followupStep,
        nextFollowupAt: toLocalDateTime(state.nextFollowupAt),
      }
    : { ...EMPTY_STATE };
}

function changesBetween(
  baseline: EditableState,
  current: EditableState,
): Array<{ label: string; before: string; after: string }> {
  const entries: Array<[
    keyof EditableState,
    string,
  ]> = [
    ["dnc", "Do Not Contact"],
    ["humanTakeover", "Human takeover"],
    ["paused", "Paused"],
    ["followupState", "Follow-up state"],
    ["followupStep", "Follow-up step"],
    ["nextFollowupAt", "Next follow-up"],
  ];
  const format = (value: EditableState[keyof EditableState]): string =>
    typeof value === "boolean"
      ? value
        ? "On"
        : "Off"
      : String(value || "None");
  return entries.flatMap(([key, label]) =>
    baseline[key] === current[key]
      ? []
      : [{ label, before: format(baseline[key]), after: format(current[key]) }],
  );
}

export function LeadAutomationControlClient({
  action,
  channels,
  canWrite,
}: {
  action: (formData: FormData) => Promise<void>;
  channels: string[];
  canWrite: boolean;
}): React.ReactElement {
  const availableChannels = channels.length > 0 ? channels : ["sms", "email", "dm"];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AutomationLead[]>([]);
  const [selected, setSelected] = useState<AutomationLead | null>(null);
  const [channel, setChannel] = useState(availableChannels[0] ?? "sms");
  const [baseline, setBaseline] = useState<EditableState>({ ...EMPTY_STATE });
  const [draft, setDraft] = useState<EditableState>({ ...EMPTY_STATE });
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const changes = useMemo(
    () => changesBetween(baseline, draft),
    [baseline, draft],
  );

  const selectLead = (lead: AutomationLead): void => {
    const nextState = stateForLead(lead, channel);
    setSelected(lead);
    setBaseline(nextState);
    setDraft(nextState);
    setConfirmed(false);
    setError(null);
  };

  const selectChannel = (value: string): void => {
    setChannel(value);
    const nextState = selected ? stateForLead(selected, value) : EMPTY_STATE;
    setBaseline({ ...nextState });
    setDraft({ ...nextState });
    setConfirmed(false);
  };

  const runSearch = async (): Promise<void> => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(false);
    try {
      const response = await fetch(
        `/api/team/automation/lead?q=${encodeURIComponent(normalized)}&limit=12`,
        { method: "GET", cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as {
        leads?: AutomationLead[];
        message?: string;
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          payload?.message ??
            payload?.error ??
            `Lead search failed (${response.status}).`,
        );
      }
      if (!Array.isArray(payload?.leads)) {
        throw new Error("Lead search returned an invalid response.");
      }
      setResults(payload.leads);
      setSearched(true);
    } catch (searchError) {
      setResults([]);
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Lead search failed. Try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 text-xs text-slate-600">
      <form
        role="search"
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <label className="flex flex-1 flex-col gap-1">
          <span>Find a contact or lead</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, company, email, or phone"
            minLength={2}
            maxLength={100}
            className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="min-h-11 self-end rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 hover:border-primary-400 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
          {error}{" "}
          <button
            type="button"
            onClick={() => void runSearch()}
            className="min-h-11 font-semibold underline"
          >
            Retry
          </button>
        </div>
      ) : null}
      {searched && results.length === 0 ? (
        <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
          No matching active leads were found. Try another name, email, or phone.
        </p>
      ) : null}
      {results.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="font-semibold text-slate-800">Search results</legend>
          {results.map((lead) => (
            <label
              key={lead.id}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 hover:border-primary-300"
            >
              <input
                type="radio"
                name="selectedAutomationLead"
                checked={selected?.id === lead.id}
                onChange={() => selectLead(lead)}
                className="mt-0.5 h-5 w-5"
              />
              <span>
                <span className="block font-semibold text-slate-900">
                  {lead.name}{lead.company ? ` · ${lead.company}` : ""}
                </span>
                <span className="block text-slate-500">
                  {[lead.phone, lead.email, lead.status].filter(Boolean).join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {selected ? (
        <form
          action={action}
          className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4"
          onSubmit={(event) => {
            if (!canWrite || changes.length === 0 || !confirmed) {
              event.preventDefault();
              setError(
                !canWrite
                  ? "You have read-only access."
                  : changes.length === 0
                    ? "Change at least one setting before saving."
                    : "Review and confirm the lead override before saving.",
              );
            }
          }}
        >
          <input type="hidden" name="leadId" value={selected.id} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-slate-900">{selected.name}</p>
              <p className="text-slate-500">
                Lead reference {selected.id.slice(0, 8)} · {selected.status}
              </p>
            </div>
            <a
              href={`/team/contacts?contactId=${encodeURIComponent(selected.contactId)}`}
              className="min-h-11 rounded-xl px-3 py-3 font-semibold text-primary-700 underline"
            >
              Open contact
            </a>
          </div>

          <fieldset disabled={!canWrite} className="space-y-4 disabled:opacity-70">
            <label className="flex flex-col gap-1">
              <span>Channel</span>
              <select
                name="channel"
                value={channel}
                onChange={(event) => selectChannel(event.target.value)}
                className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              >
                {availableChannels.map((value) => (
                  <option key={value} value={value}>
                    {value === "dm" ? "Messenger" : value.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                ["dnc", "Do Not Contact"],
                ["humanTakeover", "Human takeover"],
                ["paused", "Pause automation"],
              ] as const).map(([key, label]) => (
                <label
                  key={key}
                  className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 ${
                    key === "dnc"
                      ? "border-rose-200 bg-rose-50 text-rose-800"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <input
                    type="checkbox"
                    name={key}
                    checked={draft[key]}
                    onChange={(event) => {
                      setDraft({ ...draft, [key]: event.target.checked });
                      setConfirmed(false);
                    }}
                    className="h-5 w-5 rounded border-slate-300"
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className="flex flex-col gap-1">
              <span>Follow-up state</span>
              <input
                name="followupState"
                value={draft.followupState}
                onChange={(event) => {
                  setDraft({ ...draft, followupState: event.target.value });
                  setConfirmed(false);
                }}
                pattern="[a-z][a-z0-9_-]{0,63}"
                placeholder="qualifying or booked"
                className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>Follow-up step</span>
                <input
                  name="followupStep"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.followupStep}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      followupStep: Number(event.target.value),
                    });
                    setConfirmed(false);
                  }}
                  className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Next follow-up</span>
                <input
                  name="nextFollowupAt"
                  type="datetime-local"
                  value={draft.nextFollowupAt}
                  onChange={(event) => {
                    setDraft({ ...draft, nextFollowupAt: event.target.value });
                    setConfirmed(false);
                  }}
                  className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                />
              </label>
            </div>
          </fieldset>

          <section className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-blue-950">
            <h4 className="font-semibold">Review this lead override</h4>
            {changes.length === 0 ? (
              <p className="mt-1">No unsaved changes for this channel.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {changes.map((change) => (
                  <li key={change.label}>
                    <span className="font-semibold">{change.label}:</span>{" "}
                    {change.before} → {change.after}
                  </li>
                ))}
              </ul>
            )}
            <label className="mt-3 flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 py-2 font-medium">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={!canWrite || changes.length === 0}
                className="h-5 w-5"
              />
              I reviewed this lead and channel override.
            </label>
          </section>

          <p className="text-amber-800">
            This legacy override record does not yet support expected-version
            conflict checks or idempotency receipts. Refresh before editing.
          </p>
          <SubmitButton
            className="inline-flex min-h-11 items-center rounded-full bg-primary-600 px-5 py-2 font-semibold text-white disabled:opacity-50"
            pendingLabel="Saving..."
            disabled={!canWrite || changes.length === 0 || !confirmed}
          >
            Save reviewed lead override
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
