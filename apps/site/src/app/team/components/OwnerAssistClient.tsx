"use client";

import React from "react";
import { Button, cn } from "@myst-os/ui";

type Message = { id: string; sender: "bot" | "user"; text: string };

type OwnerPayload = { reply?: string };

const QUICK_PROMPTS = ["Revenue this week?", "Revenue next week?", "Payments today?", "Schedule tomorrow?"];

async function callOwnerAssistant(message: string): Promise<OwnerPayload | null> {
  try {
    const res = await fetch("/api/owner-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OwnerPayload;
    return data ?? null;
  } catch {
    return null;
  }
}

export function OwnerAssistClient(): React.ReactElement {
  const [messages, setMessages] = React.useState<Message[]>([
    {
      id: "intro",
      sender: "bot",
      text: "Hi! I’m your owner assistant. Ask about revenue, payments, or schedule. I’ll answer with live data when available."
    }
  ]);
  const [input, setInput] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [messages]);

  const handleSend = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      setIsSending(true);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
      setInput("");
      const payload = await callOwnerAssistant(text);
      const reply = payload?.reply?.trim() || "Data not available yet. Connect payments and try again.";
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "bot", text: reply }]);
      setIsSending(false);
    },
    [isSending]
  );

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await handleSend(input);
    },
    [handleSend, input]
  );

  return (
    <div className="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-xl shadow-slate-200/60">
      <div className="mb-3 flex flex-wrap gap-2">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
            onClick={() => void handleSend(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="flex h-[360px] flex-col rounded-2xl border border-slate-200 bg-white/95">
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
          {messages.map((message) => (
            <div key={message.id} className={cn("flex", message.sender === "bot" ? "justify-start" : "justify-end")}>
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
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about revenue, payments, schedule..."
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
            <Button type="submit" size="sm" disabled={isSending}>
              {isSending ? "Sending..." : "Send"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
