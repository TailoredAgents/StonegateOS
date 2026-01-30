'use client';

import * as React from "react";
import { Button, cn } from "@myst-os/ui";
import { usePathname } from "next/navigation";

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
const RESPONSE_DELAY_MIN_MS = 10_000;
const RESPONSE_DELAY_MAX_MS = 30_000;

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("price") || m.includes("cost") || m.includes("quote") || m.includes("estimate"))
    return "We price by load size. Single item pickup is $100, minimum pickup (2â€“4 items) is $150, half load $300, 3/4 load $450, and a full load $600. Weâ€™ll confirm the exact price on-site.";
  if (m.includes("mattress") || m.includes("paint") || m.includes("tire"))
    return "Base pricing is by volume. Some items have dump pass-through fees (for example, mattresses/box springs are +$40 each).";
  if (m.includes("insurance") || m.includes("licensed")) return "Yes - Stonegate is licensed and insured. COIs available on request.";
  return "Happy to help - ask about pricing ranges, what we haul, or say \"book me\" to schedule an estimate.";
}

export function ChatBot() {
  const pathname = usePathname();
  if (pathname === "/book" || pathname === "/bookbrush" || pathname.startsWith("/book/") || pathname.startsWith("/quote")) {
    return null;
  }

  const [isOpen, setIsOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [bookingInFlight, setBookingInFlight] = React.useState(false);
  const [isTyping, setIsTyping] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[]>([
    { id: "initial", sender: "bot", text: "Hi! I'm Stonegate Assist. Ask about services, pricing ranges, or how we work." }
  ]);
  const endRef = React.useRef<HTMLDivElement>(null);
  const pendingRepliesRef = React.useRef(0);
  const timersRef = React.useRef<number[]>([]);

  React.useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 150);
    return () => clearTimeout(t);
  }, [messages, isOpen]);

  React.useEffect(() => {
    return () => {
      timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      timersRef.current = [];
    };
  }, []);

  function pickResponseDelayMs(): number {
    const range = RESPONSE_DELAY_MAX_MS - RESPONSE_DELAY_MIN_MS;
    return RESPONSE_DELAY_MIN_MS + Math.floor(Math.random() * (range + 1));
  }

  function beginBotReplyDelay() {
    pendingRepliesRef.current += 1;
    setIsTyping(true);
    return { startedAt: Date.now(), delayMs: pickResponseDelayMs() };
  }

  function scheduleBotReply(
    message: Message,
    options: { startedAt: number; delayMs: number; clearBooking?: boolean }
  ) {
    const elapsed = Date.now() - options.startedAt;
    const remaining = Math.max(0, options.delayMs - elapsed);
    const timerId = window.setTimeout(() => {
      setMessages((prev) => {
        const next = options.clearBooking ? prev.map((m) => (m.booking ? { ...m, booking: undefined } : m)) : prev;
        return [...next, message];
      });
      pendingRepliesRef.current = Math.max(0, pendingRepliesRef.current - 1);
      if (pendingRepliesRef.current === 0) setIsTyping(false);
    }, remaining);
    timersRef.current.push(timerId);
  }

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

    const pacing = beginBotReplyDelay();
    const ai = await callAssistant({ message: text });
    const reply = typeof ai?.reply === "string" ? ai.reply : fallbackResponse(text);
    scheduleBotReply(
      { id: crypto.randomUUID(), sender: "bot", text: reply, ...(ai?.booking ? { booking: ai.booking } : {}) },
      pacing
    );
  };

  const handleSelectSlot = async (slot: BookingSuggestion) => {
    if (bookingInFlight) return;
    setBookingInFlight(true);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text: `Book ${formatSlot(slot)}` }]);
    try {
      const pacing = beginBotReplyDelay();
      const ai = await callAssistant({ action: { type: "select_booking_slot", startAt: slot.startAt } });
      const reply = typeof ai?.reply === "string" ? ai.reply : "Sorry - I couldn't book that slot. Try again?";
      scheduleBotReply({ id: crypto.randomUUID(), sender: "bot", text: reply }, { ...pacing, clearBooking: true });
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
             {isTyping ? (
               <div className="flex justify-start">
                 <div className="max-w-[75%] rounded-xl bg-neutral-100 px-3 py-2 text-neutral-500">
                   <span className="sr-only">Stonegate Assist is typing</span>
                   <span className="flex items-center gap-1" aria-hidden="true">
                     <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: "0ms" }} />
                     <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: "150ms" }} />
                     <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: "300ms" }} />
                   </span>
                 </div>
               </div>
             ) : null}
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
