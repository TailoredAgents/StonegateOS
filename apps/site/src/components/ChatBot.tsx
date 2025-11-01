'use client';

import * as React from "react";
import { Button, cn } from "@myst-os/ui";

interface Message {
  id: string;
  sender: "bot" | "user";
  text: string;
}

const SUGGESTIONS = [
  "What services do you offer?",
  "How long does a visit take?",
  "What solutions do you use?"
];

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("sofa") || m.includes("couch") || m.includes("furniture")) return "Most furniture items run $80-$140 depending on size and access.";
  if (m.includes("mattress")) return "Mattress pickup typically ranges $70-$120 based on size and stairs.";
  if (m.includes("appliance") || m.includes("fridge") || m.includes("refrigerator") || m.includes("washer") || m.includes("dryer")) return "Appliance hauling usually runs $80-$150; freon handling may add a surcharge.";
  if (m.includes("hot tub") || m.includes("spa")) return "Hot tub removals commonly fall between $250-$450 depending on access and cut-up needs.";
  if (m.includes("yard") || m.includes("debris") || m.includes("construction") || m.includes("renovation")) return "Light construction or yard debris often ranges $150-$350 per load depending on volume and material.";
  if (m.includes("insurance") || m.includes("licensed")) return "Yes—Stonegate is licensed and insured. COIs available on request.";
  return "Thanks for the question! Book an on-site estimate so we can confirm details and give exact pricing.";
}

export function ChatBot() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Message[]>([
    { id: "initial", sender: "bot", text: "Hi! I'm Stonegate Assist. Ask about services, pricing ranges, or how we work." }
  ]);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 150);
    return () => clearTimeout(t);
  }, [messages, isOpen]);

  async function callAssistant(message: string): Promise<string | null> {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown as { ok?: boolean; reply?: string };
      return typeof data?.reply === "string" ? data.reply : null;
    } catch {
      return null;
    }
  }

  const handleSend = async (message: string) => {
    const text = message.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
    setInput("");

    const ai = await callAssistant(text);
    const reply = ai ?? fallbackResponse(text);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "bot", text: reply }]);
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
              ×
            </button>
          </div>
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={cn("flex", m.sender === "bot" ? "justify-start" : "justify-end")}>
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
        {isOpen ? "Hide Assistant" : "Ask Myst"}
      </Button>
    </div>
  );
}


