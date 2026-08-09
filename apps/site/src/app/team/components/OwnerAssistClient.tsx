"use client";

import React from "react";
import { Button, cn } from "@myst-os/ui";
import type {
  OwnerAssistantSourceCitation,
  OwnerAssistantWarning,
} from "@/app/api/owner-chat/contract";

type Message = {
  id: string;
  sender: "bot" | "user";
  text: string;
  sources?: OwnerAssistantSourceCitation[];
  warning?: OwnerAssistantWarning | null;
};

type OwnerSuccessPayload = {
  ok: true;
  reply: string;
  sources: OwnerAssistantSourceCitation[];
  warning?: OwnerAssistantWarning | null;
};

type OwnerCallResult =
  | { ok: true; payload: OwnerSuccessPayload }
  | { ok: false; message: string; retryable: boolean };

type RawOwnerPayload = {
  ok?: unknown;
  reply?: unknown;
  sources?: unknown;
  warning?: unknown;
  message?: unknown;
  retryable?: unknown;
};

const QUICK_PROMPTS = [
  "Revenue this week?",
  "Payment issues?",
  "Schedule tomorrow?",
];

function isSourceCitation(
  value: unknown,
): value is OwnerAssistantSourceCitation {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<OwnerAssistantSourceCitation>;
  return (
    ["revenue", "payment_reconciliation", "schedule"].includes(
      source.id ?? "",
    ) &&
    typeof source.label === "string" &&
    ["available", "empty", "forbidden", "unavailable"].includes(
      source.status ?? "",
    ) &&
    typeof source.checkedAt === "string" &&
    typeof source.detail === "string" &&
    typeof source.href === "string" &&
    source.href.startsWith("/team")
  );
}

function isOwnerWarning(value: unknown): value is OwnerAssistantWarning {
  if (!value || typeof value !== "object") return false;
  const warning = value as Partial<OwnerAssistantWarning>;
  return (
    warning.code === "ai_provider_failed" && typeof warning.message === "string"
  );
}

async function callOwnerAssistant(message: string): Promise<OwnerCallResult> {
  try {
    const response = await fetch("/api/owner-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    const raw = (await response
      .json()
      .catch(() => null)) as RawOwnerPayload | null;

    if (!response.ok || raw?.ok !== true) {
      return {
        ok: false,
        message:
          typeof raw?.message === "string" && raw.message.trim()
            ? raw.message
            : response.status === 401
              ? "Your session expired. Sign in again, then retry."
              : response.status === 403
                ? "You do not have permission to use Owner Assistant."
                : "Owner Assistant could not answer right now.",
        retryable: raw?.retryable === true || response.status >= 500,
      };
    }

    const reply = typeof raw.reply === "string" ? raw.reply.trim() : "";
    if (!reply || !Array.isArray(raw.sources)) {
      return {
        ok: false,
        message:
          "Owner Assistant returned an incomplete response. No answer was accepted.",
        retryable: true,
      };
    }

    return {
      ok: true,
      payload: {
        ok: true,
        reply,
        sources: raw.sources.filter(isSourceCitation),
        warning: isOwnerWarning(raw.warning) ? raw.warning : null,
      },
    };
  } catch {
    return {
      ok: false,
      message:
        "Owner Assistant is unreachable. Your question was kept so you can retry.",
      retryable: true,
    };
  }
}

function formatCheckedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Check time unavailable";
  return `Checked ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed)}`;
}

function sourceStatusLabel(status: OwnerAssistantSourceCitation["status"]) {
  if (status === "available") return "Available";
  if (status === "empty") return "No matching records";
  if (status === "forbidden") return "Permission required";
  return "Unavailable";
}

function sourceStatusClass(status: OwnerAssistantSourceCitation["status"]) {
  if (status === "available" || status === "empty") {
    return "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100";
  }
  if (status === "forbidden") {
    return "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100";
  }
  return "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-100";
}

export function OwnerAssistClient(): React.ReactElement {
  const [messages, setMessages] = React.useState<Message[]>([
    {
      id: "intro",
      sender: "bot",
      text: "Ask about completed job revenue, payment issues, or the schedule. Every answer identifies the source it checked, and unavailable data is never treated as zero.",
    },
  ]);
  const [input, setInput] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [error, setError] = React.useState<{
    message: string;
    retryable: boolean;
    question: string;
  } | null>(null);
  const sendingRef = React.useRef(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    endRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [messages]);

  const handleSend = React.useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sendingRef.current) return;

    sendingRef.current = true;
    setIsSending(true);
    setError(null);
    setMessages((previous) => [
      ...previous,
      { id: crypto.randomUUID(), sender: "user", text },
    ]);
    setInput("");

    try {
      const result = await callOwnerAssistant(text);
      if (!result.ok) {
        setError({
          message: result.message,
          retryable: result.retryable,
          question: text,
        });
        setInput((current) => (current.trim() ? current : text));
        return;
      }

      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          sender: "bot",
          text: result.payload.reply,
          sources: result.payload.sources,
          warning: result.payload.warning,
        },
      ]);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  }, []);

  const handleSubmit = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void handleSend(input);
    },
    [handleSend, input],
  );

  return (
    <section
      className="rounded-3xl border border-slate-200 bg-white/90 p-4 shadow-xl shadow-slate-200/60 dark:border-slate-700 dark:bg-slate-900/90 dark:shadow-black/30 sm:p-6"
      aria-labelledby="owner-assistant-heading"
    >
      <div>
        <h2
          id="owner-assistant-heading"
          className="text-lg font-semibold text-slate-950 dark:text-white"
        >
          Owner Assistant
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Read-only answers from sources your current team session may access.
        </p>
      </div>

      <div
        className="mt-4 flex flex-wrap gap-2"
        aria-label="Suggested questions"
      >
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="min-h-11 rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-primary-400 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:border-primary-500 dark:hover:text-primary-200"
            onClick={() => void handleSend(prompt)}
            disabled={isSending}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="mt-3 flex h-[420px] flex-col rounded-2xl border border-slate-200 bg-white/95 dark:border-slate-700 dark:bg-slate-950/80">
        <div
          className="flex-1 space-y-3 overflow-y-auto px-3 py-4 text-sm sm:px-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-busy={isSending}
        >
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex",
                message.sender === "bot" ? "justify-start" : "justify-end",
              )}
            >
              <div
                className={cn(
                  "max-w-[94%] rounded-xl px-3 py-2 leading-relaxed sm:max-w-[78%]",
                  message.sender === "bot"
                    ? "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                    : "bg-primary-100 text-slate-950 shadow-md shadow-primary-900/10 dark:bg-primary-900/60 dark:text-primary-50",
                )}
              >
                <p className="whitespace-pre-wrap">{message.text}</p>
                {message.warning ? (
                  <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
                    {message.warning.message}
                  </p>
                ) : null}
                {message.sources?.length ? (
                  <ul className="mt-3 space-y-2" aria-label="Answer sources">
                    {message.sources.map((source) => (
                      <li
                        key={source.id}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-xs",
                          sourceStatusClass(source.status),
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <a
                            href={source.href}
                            className="font-semibold underline decoration-current/40 underline-offset-2 hover:decoration-current"
                          >
                            {source.label}
                          </a>
                          <span>{sourceStatusLabel(source.status)}</span>
                        </div>
                        <p className="mt-1">{source.detail}</p>
                        <p className="mt-1 opacity-75">
                          {formatCheckedAt(source.checkedAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
          {isSending ? (
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Checking permitted sources…
            </p>
          ) : null}
          <div ref={endRef} />
        </div>

        <div className="border-t border-slate-200 px-3 py-3 dark:border-slate-700 sm:px-4">
          {error ? (
            <div
              className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-950 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-100"
              role="alert"
            >
              <p className="font-semibold">Answer not added</p>
              <p className="mt-1">{error.message}</p>
              {error.retryable ? (
                <button
                  type="button"
                  className="mt-2 min-h-11 rounded-lg border border-rose-300 px-3 py-2 font-semibold hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 dark:border-rose-700 dark:hover:bg-rose-900"
                  onClick={() => void handleSend(error.question)}
                  disabled={isSending}
                >
                  Retry this question
                </button>
              ) : null}
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <label htmlFor="owner-assistant-question" className="sr-only">
              Ask Owner Assistant
            </label>
            <textarea
              id="owner-assistant-question"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about revenue, payment issues, or schedule…"
              rows={2}
              maxLength={2_000}
              className="min-h-11 flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-primary-900"
            />
            <Button
              type="submit"
              size="sm"
              className="min-h-11"
              disabled={isSending || !input.trim()}
            >
              {isSending ? "Checking…" : "Send"}
            </Button>
          </form>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Read-only: the Assistant cannot send, refund, reconcile, or change
            records.
          </p>
        </div>
      </div>
    </section>
  );
}
