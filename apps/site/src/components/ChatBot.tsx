'use client';

import * as React from "react";
import { Button, cn } from "@myst-os/ui";

type BookingSuggestion = { startAt: string; endAt: string; reason?: string; services?: string[] };
type BookingPayload = {
  suggestions: BookingSuggestion[];
  propertyLabel?: string;
};

type AssistantPayload = {
  ok?: boolean;
  reply?: string;
  booking?: BookingPayload;
};

interface Message {
  id: string;
  sender: "bot" | "user";
  text: string;
  booking?: BookingPayload;
}

const SUGGESTIONS = [
  "What services do you offer?",
  "What does a half-trailer usually cost?",
  "Can you book me for an estimate?"
];

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("price") || m.includes("cost") || m.includes("quote") || m.includes("estimate"))
    return "We price strictly by trailer volume: 1/4 $200, 1/2 $400, 3/4 $600, full $800 (before promos). We'll confirm the exact price on-site.";
  if (m.includes("mattress") || m.includes("paint") || m.includes("tire"))
    return "Base pricing is by volume. Disposal pass-through fees apply if needed: +$50 per mattress, +$30 per paint container, +$10 per tire.";
  if (m.includes("insurance") || m.includes("licensed")) return "Yes - Stonegate is licensed and insured. COIs available on request.";
  return "Happy to help - ask about pricing ranges, what we haul, or say \"book me\" to schedule an estimate.";
}

export function ChatBot() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [bookingInFlight, setBookingInFlight] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[]>([
    { id: "initial", sender: "bot", text: "Hi! I'm Stonegate Assist. Ask about services, pricing ranges, or how we work." }
  ]);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 150);
    return () => clearTimeout(t);
  }, [messages, isOpen]);

  function formatSlot(s: BookingSuggestion): string {
    const start = new Date(s.startAt);
    const end = new Date(s.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Time slot";
    return `${start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  async function callAssistant(payload: { message?: string; action?: { type: string; startAt?: string } }): Promise<AssistantPayload | null> {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = (await res.json().catch(() => null)) as AssistantPayload | null;
      if (!data) return null;
      return data;
    } catch {
      return null;
    }
  }

  const handleSend = async (message: string) => {
    const text = message.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
    setInput("");

    const ai = await callAssistant({ message: text });
    const reply = typeof ai?.reply === "string" ? ai.reply : fallbackResponse(text);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), sender: "bot", text: reply, ...(ai?.booking ? { booking: ai.booking } : {}) }
    ]);
  };

  const handleSelectSlot = async (slot: BookingSuggestion) => {
    if (bookingInFlight) return;
    setBookingInFlight(true);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text: `Book ${formatSlot(slot)}` }]);
    try {
      const ai = await callAssistant({ action: { type: "select_booking_slot", startAt: slot.startAt } });
      const reply = typeof ai?.reply === "string" ? ai.reply : "Sorry - I couldn't book that slot. Try again?";
      setMessages((prev) => [
        ...prev.map((m) => (m.booking ? { ...m, booking: undefined } : m)),
        { id: crypto.randomUUID(), sender: "bot", text: reply }
      ]);
    } finally {
      setBookingInFlight(false);
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSend(input);
  };

  return (
    <div className="fixed right-6 bottom-24 md:bottom-6 z-50 flex flex-col items-end gap-3">
      {isOpen ? (
        <div className="w-full max-w-sm rounded-xl border border-neutral-300/70 bg-white shadow-xl shadow-primary-900/10 sm:max-w-md">
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
            <div>
              <p className="font-semibold text-primary-800">Stonegate Assist</p>
              <p className="text-xs text-neutral-500">Ask anything about our services</p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
              aria-label="Close chat"
            >
              x
            </button>
          </div>
           <div className="flex max-h-72 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm" aria-live="polite">
             {messages.map((m) => (
              <div key={m.id} className="space-y-2">
                <div className={cn("flex", m.sender === "bot" ? "justify-start" : "justify-end")}>
                  <div
                    className={cn(
                      "max-w-[92%] rounded-xl px-3 py-2 sm:max-w-[75%]",
                      m.sender === "bot"
                        ? "bg-neutral-100 text-neutral-700"
                        : "bg-primary-100 text-slate-900 shadow-md shadow-primary-800/20"
                    )}
                  >
                    {m.text}
                  </div>
                </div>
                {m.sender === "bot" && m.booking?.suggestions?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {m.booking.suggestions.slice(0, 5).map((s) => (
                      <button
                        key={s.startAt}
                        type="button"
                        onClick={() => void handleSelectSlot(s)}
                        disabled={bookingInFlight}
                        className="rounded-full border border-primary-200 bg-white px-3 py-1 text-xs font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-60"
                        title={s.reason ?? "Book this time"}
                      >
                        {formatSlot(s)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
             ))}
             <div ref={endRef} />
           </div>
          <div className="border-t border-neutral-200 px-4 py-3">
            <div className="mb-2 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-full border border-neutral-300 px-2 py-1 text-xs text-neutral-600 transition hover:border-accent-400 hover:text-accent-600"
                  onClick={() => void handleSend(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your question"
                className="flex-1 rounded-md border border-neutral-300/70 bg-white px-3 py-2 text-sm text-neutral-700 shadow-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              />
              <Button type="submit" variant="primary" size="sm">
                Send
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      <Button
        type="button"
        variant={isOpen ? "secondary" : "primary"}
        onClick={() => setIsOpen((prev) => !prev)}
        className="shadow-lg shadow-primary-900/20"
      >
        {isOpen ? "Hide Assistant" : "Ask Stonegate"}
      </Button>
    </div>
  );
}
