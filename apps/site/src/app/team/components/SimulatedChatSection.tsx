"use client";

import React from "react";

type ChatRole = "customer" | "agent";
type ChatChannel = "dm" | "sms";
type SimulationMode = "shadow" | "assist" | "auto" | "off";

type ChatMessage = {
  id: string;
  role: ChatRole;
  body: string;
  mediaUrls?: string[];
  createdAt: string;
};

type OfferedSlot = {
  label: string;
  startAt: string;
  endAt?: string | null;
};

type ContactOption = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  source: string | null;
  updatedAt: string;
};

type SimulationResult = {
  reply: string | null;
  stage: string;
  proposedAction: string;
  executedAction: string;
  reason: string;
  humanReviewReason: string | null;
  confidence: "low" | "medium" | "high";
  quoteRange: {
    lowCents: number;
    highCents: number;
    confidence: "low" | "medium" | "high";
  } | null;
  offeredSlots: OfferedSlot[];
  confirmedSlot: OfferedSlot | null;
  mode: string;
  channel: ChatChannel;
  debug: Record<string, unknown>;
};

type SavedRun = {
  id: string;
  title: string;
  channel: ChatChannel;
  contactName?: string | null;
  messages: ChatMessage[];
  lastResult: SimulationResult | null;
  savedAt: string;
};

const STORAGE_KEY = "stonegate.simulated-chat.runs.v1";
const FIRST_REPLY_DELAY_MIN_MS = 5_000;
const FIRST_REPLY_DELAY_MAX_MS = 20_000;
const FOLLOWUP_REPLY_DELAY_MIN_MS = 3_000;
const FOLLOWUP_REPLY_DELAY_MAX_MS = 10_000;
const TYPING_MS_PER_CHAR = 35;
const MIN_TYPING_MS = 1_200;
const MAX_TYPING_MS = 12_000;

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function randomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function estimateTypingDelayMs(body: string): number {
  return Math.min(
    MAX_TYPING_MS,
    Math.max(MIN_TYPING_MS, Math.round(body.trim().length * TYPING_MS_PER_CHAR)),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getSimulatedReplyTiming(body: string, firstReply: boolean): {
  thinkDelayMs: number;
  typingDelayMs: number;
} {
  const thinkDelayMs = firstReply
    ? randomIntInclusive(FIRST_REPLY_DELAY_MIN_MS, FIRST_REPLY_DELAY_MAX_MS)
    : randomIntInclusive(FOLLOWUP_REPLY_DELAY_MIN_MS, FOLLOWUP_REPLY_DELAY_MAX_MS);
  return {
    thinkDelayMs,
    typingDelayMs: estimateTypingDelayMs(body),
  };
}

function formatMoneyRange(range: SimulationResult["quoteRange"]): string {
  if (!range) return "None";
  return `$${Math.round(range.lowCents / 100)}-$${Math.round(range.highCents / 100)}`;
}

function formatLabel(value: string | null | undefined): string {
  if (!value) return "None";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readSavedRuns(): SavedRun[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedRun => {
      return Boolean(
        item && typeof item === "object" && "id" in item && "messages" in item,
      );
    });
  } catch {
    return [];
  }
}

function buildRunTitle(
  messages: ChatMessage[],
  result: SimulationResult | null,
  contactName?: string | null,
): string {
  const firstCustomer =
    messages.find((message) => message.role === "customer")?.body ??
    "Simulation";
  const label = firstCustomer.replace(/\s+/g, " ").trim().slice(0, 46);
  const prefix = contactName ? `${contactName}: ` : "";
  return `${prefix}${label || "Simulation"} - ${formatLabel(result?.proposedAction ?? "no action")}`;
}

export function SimulatedChatSection(): React.ReactElement {
  const [channel, setChannel] = React.useState<ChatChannel>("dm");
  const [simulationMode, setSimulationMode] =
    React.useState<SimulationMode>("shadow");
  const [contactSearch, setContactSearch] = React.useState("");
  const [contactOptions, setContactOptions] = React.useState<ContactOption[]>(
    [],
  );
  const [selectedContact, setSelectedContact] =
    React.useState<ContactOption | null>(null);
  const [isLoadingContacts, setIsLoadingContacts] = React.useState(false);
  const [contactError, setContactError] = React.useState<string | null>(null);
  const [input, setInput] = React.useState("");
  const [includePhotos, setIncludePhotos] = React.useState(false);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [lastResult, setLastResult] = React.useState<SimulationResult | null>(
    null,
  );
  const [savedRuns, setSavedRuns] = React.useState<SavedRun[]>([]);
  const [isSending, setIsSending] = React.useState(false);
  const [isAgentTyping, setIsAgentTyping] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSavedRuns(readSavedRuns());
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setIsLoadingContacts(true);
      setContactError(null);
      const params = new URLSearchParams();
      params.set("limit", "12");
      if (contactSearch.trim()) params.set("q", contactSearch.trim());
      fetch(`/api/team/contacts?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as {
            contacts?: ContactOption[];
            error?: string;
          } | null;
          if (!response.ok) {
            throw new Error(payload?.error ?? "Unable to load contacts");
          }
          setContactOptions(payload?.contacts ?? []);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setContactError(
            err instanceof Error ? err.message : "Unable to load contacts",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoadingContacts(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [contactSearch]);

  const persistRuns = React.useCallback((runs: SavedRun[]) => {
    setSavedRuns(runs);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(0, 30)));
  }, []);

  const saveCurrentRun = React.useCallback(() => {
    if (messages.length === 0) return;
    const run: SavedRun = {
      id: createId(),
      title: buildRunTitle(messages, lastResult, selectedContact?.name ?? null),
      channel,
      contactName: selectedContact?.name ?? null,
      messages,
      lastResult,
      savedAt: new Date().toISOString(),
    };
    persistRuns([run, ...savedRuns].slice(0, 30));
  }, [channel, lastResult, messages, persistRuns, savedRuns, selectedContact]);

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = input.trim();
    if (!body || isSending) return;

    const customerMessage: ChatMessage = {
      id: createId(),
      role: "customer",
      body,
      mediaUrls: includePhotos ? ["simulated-photo://customer-upload"] : [],
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, customerMessage];
    setMessages(nextMessages);
    setInput("");
    setIncludePhotos(false);
    setIsSending(true);
    setError(null);

    try {
      const response = await fetch("/api/team/simulated-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          simulationMode,
          contactId: selectedContact?.id ?? null,
          messages: nextMessages.map((message) => ({
            role: message.role,
            body: message.body,
            mediaUrls: message.mediaUrls ?? [],
            createdAt: message.createdAt,
          })),
          previousQuoteRange: lastResult?.quoteRange ?? null,
          previousOfferedSlots: lastResult?.offeredSlots ?? [],
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: SimulationResult;
        error?: string;
      } | null;
      if (!response.ok || !payload?.ok || !payload.result) {
        throw new Error(payload?.error ?? "Simulation failed");
      }

      const result = payload.result;
      const agentBody =
        result.reply ??
        `Simulation note: no customer reply would be sent. Reason: ${formatLabel(result.reason)}.`;
      setLastResult(result);
      if (result.reply) {
        const firstReply = !nextMessages.some(
          (message) => message.role === "agent",
        );
        const timing = getSimulatedReplyTiming(agentBody, firstReply);
        await sleep(timing.thinkDelayMs);
        setIsAgentTyping(true);
        await sleep(timing.typingDelayMs);
        setIsAgentTyping(false);
      }
      setMessages([
        ...nextMessages,
        {
          id: createId(),
          role: "agent",
          body: agentBody,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setIsAgentTyping(false);
      setIsSending(false);
    }
  }

  function startNewSimulation() {
    if (messages.length > 0) {
      const run: SavedRun = {
        id: createId(),
        title: buildRunTitle(
          messages,
          lastResult,
          selectedContact?.name ?? null,
        ),
        channel,
        contactName: selectedContact?.name ?? null,
        messages,
        lastResult,
        savedAt: new Date().toISOString(),
      };
      persistRuns([run, ...savedRuns].slice(0, 30));
    }
    setMessages([]);
    setLastResult(null);
    setError(null);
    setInput("");
    setIncludePhotos(false);
    setIsAgentTyping(false);
  }

  return (
    <section className="space-y-4">
      <header className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-5 shadow-[0_18px_36px_var(--team-card-shadow)]">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-[color:var(--team-text)]">
              Simulated chat
            </h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-[color:var(--team-text-muted)]">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1">
                No real SMS
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1">
                No real Facebook message
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1">
                No real booking
              </span>
              {selectedContact ? (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
                  Context: {selectedContact.name}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveCurrentRun}
              disabled={messages.length === 0 || isSending}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save run
            </button>
            <button
              type="button"
              onClick={startNewSimulation}
              disabled={isSending}
              className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              New simulation
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] shadow-[0_18px_36px_var(--team-card-shadow)]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--team-border)] p-4">
            <label className="flex min-w-[180px] flex-col gap-1 text-xs font-medium text-[color:var(--team-text-muted)]">
              Channel
              <select
                value={channel}
                onChange={(event) =>
                  setChannel(event.target.value === "sms" ? "sms" : "dm")
                }
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="dm">Facebook DM</option>
                <option value="sms">SMS</option>
              </select>
            </label>
            <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-xs font-medium text-[color:var(--team-text-muted)]">
              Client context
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)]">
                <input
                  value={contactSearch}
                  onChange={(event) => setContactSearch(event.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder="Search name, phone, email, address"
                />
                <select
                  value={selectedContact?.id ?? ""}
                  onChange={(event) => {
                    const next =
                      contactOptions.find(
                        (contact) => contact.id === event.target.value,
                      ) ?? null;
                    setSelectedContact(next);
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                >
                  <option value="">
                    {isLoadingContacts ? "Loading..." : "No client selected"}
                  </option>
                  {selectedContact &&
                  !contactOptions.some(
                    (contact) => contact.id === selectedContact.id,
                  ) ? (
                    <option value={selectedContact.id}>
                      {selectedContact.name}
                    </option>
                  ) : null}
                  {contactOptions.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                      {contact.phoneE164 || contact.phone
                        ? ` - ${contact.phoneE164 ?? contact.phone}`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
              {selectedContact ? (
                <button
                  type="button"
                  onClick={() => setSelectedContact(null)}
                  className="w-fit text-xs font-semibold text-slate-500 hover:text-slate-800"
                >
                  Clear selected client
                </button>
              ) : contactError ? (
                <span className="text-xs text-rose-600">{contactError}</span>
              ) : null}
            </label>
            <label className="flex min-w-[180px] flex-col gap-1 text-xs font-medium text-[color:var(--team-text-muted)]">
              Simulation mode
              <select
                value={simulationMode}
                onChange={(event) => {
                  const value = event.target.value;
                  setSimulationMode(
                    value === "assist" ||
                      value === "auto" ||
                      value === "off"
                      ? value
                      : "shadow",
                  );
                }}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="shadow">Shadow test</option>
                <option value="assist">Assist test</option>
                <option value="auto">Auto test</option>
                <option value="off">Off</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="text-slate-500">Stage</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatLabel(lastResult?.stage)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="text-slate-500">Action</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatLabel(lastResult?.proposedAction)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="text-slate-500">Quote</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatMoneyRange(lastResult?.quoteRange ?? null)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="text-slate-500">Mode</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatLabel(lastResult?.mode)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[440px] flex-col">
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                  Start with a customer message like “How much for a couch in
                  30144?” or “Can you remove a hot tub?”
                </div>
              ) : null}
              {messages.map((message) => {
                const isCustomer = message.role === "customer";
                return (
                  <div
                    key={message.id}
                    className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                        isCustomer
                          ? "border border-slate-200 bg-white text-slate-800"
                          : "bg-slate-900 text-white"
                      }`}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                        {isCustomer ? "Customer" : "Agent"}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap">
                        {message.body}
                      </div>
                      {message.mediaUrls?.length ? (
                        <div className="mt-2 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                          Photo included
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {isAgentTyping ? (
                <div className="flex justify-end">
                  <div className="max-w-[82%] rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                      Agent
                    </div>
                    <div className="mt-2 flex items-center gap-1" aria-label="Agent is typing">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-white/80" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-white/80 [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-white/80 [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <form
              onSubmit={(event) => {
                void sendMessage(event);
              }}
              className="border-t border-[color:var(--team-border)] p-4"
            >
              {error ? (
                <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              ) : null}
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-[color:var(--team-text-muted)]">
                  Customer message
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    rows={3}
                    className="min-h-[86px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    placeholder="Type as the customer..."
                  />
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
                    <input
                      type="checkbox"
                      checked={includePhotos}
                      onChange={(event) =>
                        setIncludePhotos(event.target.checked)
                      }
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Include photos
                  </label>
                  <button
                    type="submit"
                    disabled={!input.trim() || isSending}
                    className="min-h-[44px] rounded-xl bg-primary-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isAgentTyping ? "Typing..." : isSending ? "Thinking..." : "Send"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-[0_18px_36px_var(--team-card-shadow)]">
            <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
              Decision details
            </h3>
            <dl className="mt-3 space-y-2 text-xs text-slate-600">
              <div>
                <dt className="font-semibold text-slate-500">Reason</dt>
                <dd className="mt-1 text-slate-800">
                  {lastResult?.reason ?? "None"}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-500">Human review</dt>
                <dd className="mt-1 text-slate-800">
                  {lastResult?.humanReviewReason ?? "No"}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-500">Confidence</dt>
                <dd className="mt-1 text-slate-800">
                  {formatLabel(lastResult?.confidence)}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-500">Confirmed slot</dt>
                <dd className="mt-1 text-slate-800">
                  {lastResult?.confirmedSlot?.label ?? "None"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-[0_18px_36px_var(--team-card-shadow)]">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
                Saved runs
              </h3>
              <button
                type="button"
                onClick={() => persistRuns([])}
                disabled={savedRuns.length === 0}
                className="text-xs font-semibold text-slate-500 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {savedRuns.length === 0 ? (
                <p className="text-sm text-slate-500">No saved runs yet.</p>
              ) : null}
              {savedRuns.map((run) => (
                <details
                  key={run.id}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2"
                >
                  <summary className="cursor-pointer list-none text-sm font-semibold text-slate-800">
                    {run.title}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {run.channel === "dm" ? "Facebook DM" : "SMS"}
                    </span>
                    {run.contactName ? (
                      <span className="ml-2 text-xs font-normal text-emerald-700">
                        {run.contactName}
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                    <div className="text-xs text-slate-500">
                      Saved {new Date(run.savedAt).toLocaleString()}
                    </div>
                    <div className="space-y-2">
                      {run.messages.map((message) => (
                        <div
                          key={message.id}
                          className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"
                        >
                          <span className="font-semibold">
                            {message.role === "customer" ? "Customer" : "Agent"}
                            :
                          </span>{" "}
                          {message.body}
                        </div>
                      ))}
                    </div>
                    {run.lastResult ? (
                      <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        {formatLabel(run.lastResult.proposedAction)} -{" "}
                        {run.lastResult.reason}
                      </div>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
