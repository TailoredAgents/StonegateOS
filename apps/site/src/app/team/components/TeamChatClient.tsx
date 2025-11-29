"use client";

import React from "react";
import { Button, cn } from "@myst-os/ui";

type SpeechRecognitionType = {
  start: () => void;
  stop: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

type Message = { id: string; sender: "bot" | "user"; text: string };

const TEAM_SUGGESTIONS: string[] = [
  "Summarize today's schedule for the crew.",
  "Draft a follow-up text after a quote visit.",
  "List action items for open tasks.",
  "Share tips for handling a tough stain."
];

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("schedule"))
    return "Today's run: morning appliance pickup, mid-day garage cleanout, late afternoon curbside furniture haul. Keep tie-downs and dollies ready.";
  if (m.includes("follow-up") || m.includes("text"))
    return "Example follow-up: Thanks for having us out today! Let me know if you have questions about the quote.";
  if (m.includes("task") || m.includes("pipeline"))
    return "Review pipeline cards for New and Scheduled Estimate, add reminders when activity is 7+ days old, and attach notes for context.";
  if (m.includes("stain") || m.includes("rust"))
    return "For heavy items: team lift with straps/dollies, protect floors, and clear pathways. Separate recyclables when possible.";
  return "Got it! Emphasize safety, document before/after photos, and keep the customer looped in.";
}

type AssistantPayload = { reply?: string; actionNote?: string };

async function callAssistant(message: string): Promise<AssistantPayload | null> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    if (!response.ok) return null;
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
      text: "Hi! I'm Stonegate Assist. Ask about schedules, follow-ups, pricing ranges, or workflow tips."
    }
  ]);
  const [input, setInput] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [isListening, setIsListening] = React.useState(false);
  const [supportsSpeech, setSupportsSpeech] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const recognitionRef = React.useRef<SpeechRecognitionType | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [messages]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognitionCtor =
      (window as typeof window & { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (typeof SpeechRecognitionCtor !== "function") return;
    const recognition = new (SpeechRecognitionCtor as new () => SpeechRecognitionType)();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript && transcript.trim().length > 0) {
        setInput((prev) => (prev ? `${prev} ${transcript.trim()}` : transcript.trim()));
      }
      setIsListening(false);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setSupportsSpeech(true);
  }, []);

  const handleSend = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      setIsSending(true);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
      setInput("");

      const payload = await callAssistant(text);
      const reply = payload?.reply?.trim() || fallbackResponse(text);
      const actionNote = payload?.actionNote?.trim();
      const combinedReply = actionNote ? `${reply}\n\n${actionNote}` : reply;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "bot", text: combinedReply }]);
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

  const handleMicToggle = React.useCallback(() => {
    if (!supportsSpeech || !recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        setIsListening(true);
        recognitionRef.current.start();
      } catch {
        setIsListening(false);
      }
    }
  }, [supportsSpeech, isListening]);

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
            <div className="mb-3 flex flex-wrap gap-2">
              {TEAM_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
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
                placeholder="Type a question..."
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!supportsSpeech}
                onClick={handleMicToggle}
              >
                {supportsSpeech ? (isListening ? "Stop" : "Mic") : "No mic"}
              </Button>
              <Button type="submit" size="sm" disabled={isSending}>
                {isSending ? "Sending..." : "Send"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

