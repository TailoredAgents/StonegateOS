'use client';

import React from "react";
import { Button, cn } from "@myst-os/ui";

type Message = {
  id: string;
  sender: "bot" | "user";
  text: string;
};

const TEAM_SUGGESTIONS: string[] = [
  "Summarize today's schedule for the crew.",
  "Draft a follow-up text after a quote visit.",
  "List action items for open tasks.",
  "Share tips for handling a tough stain."
];

const TEAM_CONTEXT =
  "You are Stonegate Assist, helping the Stonegate junk removal team inside their internal Team Console. Provide concise, actionable guidance for crew and owners. If pricing is needed, reference general ranges and encourage booking a quote when specifics are missing.";

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("schedule")) return "Today's run: morning driveway degrease, mid-day deck refresh, late afternoon whole-home soft wash. Keep pre-rinse gear ready.";
  if (m.includes("follow-up") || m.includes("text"))
    return "Example follow-up: “Thanks for having us out today! Let me know if you have questions about the quote. We can get you on the calendar as soon as you’re ready.”";
  if (m.includes("task") || m.includes("pipeline"))
    return "Review pipeline cards for New and Scheduled Quote, add reminders when activity is 7+ days old, and attach notes for context.";
  if (m.includes("stain") || m.includes("rust"))
    return "Pre-treat tough stains with surfactant + sodium hypochlorite mix, let dwell 10 minutes, then soft-rinse. For rust, use an oxalic-based recovery product.";
  if (m.includes("upsell"))
    return "Upsell ideas: window rinse after house wash, driveway refresh with deck cleaning, or gutter clear paired with roof treatment.";
  return "Got it! Emphasize safety, document before/after pics in the job notes, and keep the customer looped in with friendly updates.";
}

type AssistantPayload = {
  reply?: string;
  actionNote?: string;
};

async function callAssistant(message: string): Promise<AssistantPayload | null> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as AssistantPayload;
    return data ?? null;
  } catch {
    return null;
  }
}

export function TeamChatClient() {
  const [messages, setMessages] = React.useState<Message[]>([
    {
      id: "intro",
      sender: "bot",
      text: "Hi! I'm Stonegate Assist. Ask me about schedules, follow-ups, pricing ranges, or workflow tips."
    }
  ]);
  const [input, setInput] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);
  const [isSending, setIsSending] = React.useState(false);

  React.useEffect(() => {
    const timeout = setTimeout(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 120);
    return () => clearTimeout(timeout);
  }, [messages]);

  const handleSend = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
      setInput("");
      setIsSending(true);

      const augmentedPrompt = `${TEAM_CONTEXT}\n\nTeam request: ${text}`;
      const ai = await callAssistant(augmentedPrompt);
      const reply = ai?.reply ?? fallbackResponse(text);
      const combinedReply =
        ai?.actionNote && ai.actionNote.trim().length
          ? `${reply}\n\n${ai.actionNote}`
          : reply;

      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "bot", text: combinedReply }]);
      setIsSending(false);
    },
    [isSending]
  );

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleSend(input);
    },
    [handleSend, input]
  );

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Stonegate Assist Chat</h2>
            <p className="text-sm text-slate-500">
              Quick answers for owners and crew. Ask about workflow steps, pricing ranges, or customer messaging.
            </p>
          </div>
        </header>

        <div className="mt-5 flex h-[420px] flex-col rounded-2xl border border-slate-200 bg-white/95">
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn("flex", message.sender === "bot" ? "justify-start" : "justify-end")}
              >
                <div
                  className={cn(
                    "max-w-[92%] rounded-xl px-3 py-2 leading-relaxed sm:max-w-[75%]",
                    message.sender === "bot"
                      ? "bg-slate-100 text-slate-700"
                      : "bg-primary-100 text-slate-900 shadow-md shadow-primary-900/20"
                  )}
                >
                  {message.text}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <div className="border-t border-slate-200 px-4 py-3">
            <div className="mb-3 flex flex-wrap gap-2">
              {TEAM_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                  onClick={() => void handleSend(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Type a question…"
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
              <Button type="submit" size="sm" disabled={isSending || !input.trim()}>
                {isSending ? "Sending…" : "Send"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
