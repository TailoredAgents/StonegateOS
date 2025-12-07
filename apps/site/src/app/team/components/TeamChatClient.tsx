"use client";

import React from "react";
import { Button, cn } from "@myst-os/ui";

type BookingSuggestion = { startAt: string; endAt: string; reason: string };

type Message = {
  id: string;
  sender: "bot" | "user";
  text: string;
  booking?: {
    contactId: string;
    propertyId: string;
    suggestions: BookingSuggestion[];
  };
};

type ContactOption = {
  id: string;
  name: string;
  properties: Array<{
    id: string;
    label: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  }>;
};

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

type AssistantPayload = {
  reply?: string;
  actionNote?: string;
  booking?: {
    contactId: string;
    propertyId: string;
    suggestions: BookingSuggestion[];
  };
};

async function callAssistant(
  message: string,
  contactId?: string,
  propertyId?: string,
  propertyMeta?: {
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  }
): Promise<AssistantPayload | null> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, contactId, propertyId, property: propertyMeta })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as AssistantPayload;
    return data ?? null;
  } catch {
    return null;
  }
}

export function TeamChatClient({ contacts }: { contacts: ContactOption[] }) {
  const [messages, setMessages] = React.useState<Message[]>([
    {
      id: "intro",
      sender: "bot",
      text: "Hi! I'm Stonegate Assist. Ask about schedules, follow-ups, pricing ranges, or workflow tips."
    }
  ]);
  const [input, setInput] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);
  const [supportsRecording, setSupportsRecording] = React.useState(false);
  const [selectedContactId, setSelectedContactId] = React.useState<string>(contacts[0]?.id ?? "");
  const [selectedPropertyId, setSelectedPropertyId] = React.useState<string>(contacts[0]?.properties[0]?.id ?? "");
  const [bookingInFlight, setBookingInFlight] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const mediaRecorderRef = React.useRef<any>(null);
  const chunksRef = React.useRef<BlobPart[]>([]);
  const lastBotMessageRef = React.useRef<string>("");

  React.useEffect(() => {
    const t = setTimeout(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [messages]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setSupportsRecording(Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }, []);

  const handleSend = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      setIsSending(true);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
      setInput("");

      const selectedContact = contacts.find((c) => c.id === selectedContactId);
      const selectedProperty = selectedContact?.properties.find((p) => p.id === selectedPropertyId);

      const payload = await callAssistant(
        text,
        selectedContactId || undefined,
        selectedPropertyId || undefined,
        selectedProperty
          ? {
              addressLine1: selectedProperty.addressLine1,
              city: selectedProperty.city,
              state: selectedProperty.state,
              postalCode: selectedProperty.postalCode
            }
          : undefined
      );
      const reply = payload?.reply?.trim() || fallbackResponse(text);
      const actionNote = payload?.actionNote?.trim();
      const combinedReply = actionNote ? `${reply}\n\n${actionNote}` : reply;
      const booking =
        payload?.booking && payload.booking.suggestions.length
          ? {
              contactId: payload.booking.contactId,
              propertyId: payload.booking.propertyId,
              suggestions: payload.booking.suggestions
            }
          : undefined;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sender: "bot",
          text: combinedReply,
          ...(booking ? { booking } : {})
        }
      ]);
      lastBotMessageRef.current = combinedReply;
      setIsSending(false);
    },
    [contacts, isSending, selectedContactId, selectedPropertyId]
  );

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await handleSend(input);
    },
    [handleSend, input]
  );

  const stopRecording = React.useCallback(() => {
    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const uploadAudio = React.useCallback(async (blob: Blob) => {
    try {
      const form = new FormData();
      form.append("audio", blob, "audio.webm");
      const res = await fetch("/api/chat/stt", { method: "POST", body: form });
      if (!res.ok) return;
      const data = (await res.json()) as { transcript?: string };
      const transcript = data.transcript?.trim() ?? "";
      if (transcript.length > 0) {
        setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    } catch {
      // ignore
    }
  }, []);

  const handleMicToggle = React.useCallback(async () => {
    if (!supportsRecording) return;
    if (isRecording) {
      stopRecording();
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        uploadAudio(blob);
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
      };
      mr.onerror = () => {
        setIsRecording(false);
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      mr.start();
    } catch {
      setIsRecording(false);
    }
  }, [supportsRecording, isRecording, stopRecording, uploadAudio]);

  const handleSpeak = React.useCallback(async () => {
    const text = lastBotMessageRef.current.trim();
    if (!text) return;
    try {
      const res = await fetch("/api/chat/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!res.ok) return;
      const arrayBuffer = await res.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => undefined);
    } catch {
      // ignore
    }
  }, []);

  const formatSlot = React.useCallback((suggestion: BookingSuggestion): string => {
    const start = new Date(suggestion.startAt);
    const end = new Date(suggestion.endAt);
    return `${start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} - ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }, []);

  const handleBook = React.useCallback(
    async (booking: NonNullable<Message["booking"]>, suggestion: BookingSuggestion) => {
      if (bookingInFlight) return;
      const contact = contacts.find((c) => c.id === booking.contactId);
      const property = contact?.properties.find((p) => p.id === booking.propertyId);
      const confirmLabel = `${formatSlot(suggestion)}${property ? ` at ${property.label}` : ""}`;
      const ok = typeof window !== "undefined" ? window.confirm(`Book this slot?\n${confirmLabel}`) : true;
      if (!ok) return;
      setBookingInFlight(true);
      try {
        const res = await fetch("/api/chat/book", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactId: booking.contactId,
            propertyId: booking.propertyId,
            startAt: suggestion.startAt,
            durationMinutes: 60,
            travelBufferMinutes: 30,
            services: ["junk_removal_primary"]
          })
        });
        if (!res.ok) {
          const errText = await res.text();
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              sender: "bot",
              text: `Booking failed (HTTP ${res.status}): ${errText.slice(0, 160)}`
            }
          ]);
        } else {
          const data = (await res.json()) as { appointmentId?: string; startAt?: string };
          const when = data.startAt ? new Date(data.startAt).toLocaleString() : formatSlot(suggestion);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              sender: "bot",
              text: `Booked ${when}${contact ? ` for ${contact.name}` : ""}${property ? ` at ${property.label}` : ""}.`
            }
          ]);
        }
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sender: "bot",
            text: `Booking request failed: ${(error as Error).message}`
          }
        ]);
      } finally {
        setBookingInFlight(false);
      }
    },
    [bookingInFlight, contacts, formatSlot]
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

        {contacts.length > 0 ? (
          <div className="mt-3 grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-slate-600">Contact</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={selectedContactId}
                  onChange={(e) => {
                    const cid = e.target.value;
                    setSelectedContactId(cid);
                    const contact = contacts.find((c) => c.id === cid);
                    setSelectedPropertyId(contact?.properties[0]?.id ?? "");
                  }}
                >
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-slate-600">Property</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={selectedPropertyId}
                  onChange={(e) => setSelectedPropertyId(e.target.value)}
                >
                  {(contacts.find((c) => c.id === selectedContactId)?.properties ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-slate-500">Context is used for booking suggestions/actions.</p>
          </div>
        ) : null}

        <div className="mt-5 flex h-[420px] flex-col rounded-2xl border border-slate-200 bg-white/95">
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
            {messages.map((message) => (
              <div key={message.id} className="space-y-2">
                <div className={cn("flex", message.sender === "bot" ? "justify-start" : "justify-end")}>
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

                {message.booking ? (
                  <div className="flex flex-wrap gap-2 pl-1 text-xs text-slate-600">
                    {message.booking.suggestions.map((suggestion, idx) => (
                      <button
                        key={`${message.id}-sugg-${idx}`}
                        type="button"
                        onClick={() => void handleBook(message.booking!, suggestion)}
                        disabled={bookingInFlight}
                        className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 font-semibold text-primary-800 shadow-sm transition hover:border-primary-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                        title={suggestion.reason}
                      >
                        {formatSlot(suggestion)}
                      </button>
                    ))}
                  </div>
                ) : null}
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
              <Button type="button" size="sm" disabled={!supportsRecording} onClick={handleMicToggle}>
                {supportsRecording ? (isRecording ? "Stop" : "Record") : "No mic"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={handleSpeak}>
                Speak reply
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
