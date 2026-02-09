"use client";

import React from "react";
import { Button, cn } from "@myst-os/ui";
import { formatServiceLabel } from "@/lib/service-labels";
import { TEAM_TIME_ZONE } from "../lib/timezone";

type BookingSuggestion = { startAt: string; endAt: string; reason: string; services?: string[] };
type BookingOption = BookingSuggestion & { services?: string[]; selectedService?: string };

type ActionSuggestion = {
  id: string;
  type:
    | "create_contact"
    | "create_quote"
    | "create_task"
    | "book_appointment"
    | "reschedule_appointment"
    | "send_text"
    | "create_reminder"
    | "add_contact_note";
  summary: string;
  payload: Record<string, any>;
  context?: {
    appointmentStartAt?: string | null;
    propertyLabel?: string;
  };
  note?: string | null;
};

type ActionStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "success"; message?: string }
  | { state: "error"; message?: string };

type Message = {
  id: string;
  sender: "bot" | "user";
  text: string;
  booking?: {
    contactId: string;
    propertyId: string;
    suggestions: BookingOption[];
    propertyLabel?: string;
  };
  actions?: ActionSuggestion[];
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

type ContactCandidate = {
  id: string;
  name?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  lastActivityAt?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

const TEAM_SUGGESTIONS: string[] = [
  "Summarize today's schedule for the crew.",
  "Draft a follow-up text after a quote visit.",
  "Send a good reply text to this contact.",
  "Send a text that says “On my way — see you soon.”",
  "Summarize recent notes for a lead.",
  "Share tips for handling a tough stain."
];

function fallbackResponse(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("schedule"))
    return "Today's run: morning appliance pickup, mid-day garage cleanout, late afternoon curbside furniture haul. Keep tie-downs and dollies ready.";
  if (m.includes("follow-up") || m.includes("text"))
    return "Example follow-up: Thanks for having us out today! Let me know if you have questions about the quote.";
  if (m.includes("note") || m.includes("pipeline"))
    return "Review pipeline cards for New and Booked, add a quick note after each call, and mark leads contacted so the team stays in sync.";
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
    suggestions: BookingOption[];
    propertyLabel?: string;
  };
  actions?: ActionSuggestion[];
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
      body: JSON.stringify({ message, contactId, propertyId, property: propertyMeta, mode: "team" })
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
  const [isTranscribing, setIsTranscribing] = React.useState(false);
  const [supportsRecording, setSupportsRecording] = React.useState(false);
  const defaultContextContact = contacts.length === 1 ? contacts[0] : null;
  const defaultContextProperty = defaultContextContact?.properties?.length === 1 ? defaultContextContact.properties[0] : null;
  const [bookingInFlight, setBookingInFlight] = React.useState(false);
  const [bookingStatus, setBookingStatus] = React.useState<
    | { state: "idle" }
    | { state: "confirming"; label: string }
    | { state: "success"; message: string }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const [actionStatuses, setActionStatuses] = React.useState<Record<string, ActionStatus>>({});
  const [actionServices, setActionServices] = React.useState<Record<string, string>>({});
  const [actionNotes, setActionNotes] = React.useState<Record<string, string>>({});
  const [actionDurations, setActionDurations] = React.useState<Record<string, number>>({});
  const [actionTravel, setActionTravel] = React.useState<Record<string, number>>({});
  const [actionStartDate, setActionStartDate] = React.useState<Record<string, string>>({});
  const [actionStartTime, setActionStartTime] = React.useState<Record<string, string>>({});
  const [actionReminderDate, setActionReminderDate] = React.useState<Record<string, string>>({});
  const [actionReminderTime, setActionReminderTime] = React.useState<Record<string, string>>({});
  const [actionReminderTitle, setActionReminderTitle] = React.useState<Record<string, string>>({});
  const [actionHistory, setActionHistory] = React.useState<
    Array<{ id: string; summary: string; status: ActionStatus["state"]; message?: string }>
  >([]);
  const [lastBooked, setLastBooked] = React.useState<{ appointmentId: string; message: string } | null>(null);
  const [undoStatus, setUndoStatus] = React.useState<ActionStatus>({ state: "idle" });
  const [actionPickedContacts, setActionPickedContacts] = React.useState<Record<string, ContactCandidate | null>>({});
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

  const lastBotMessageId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.sender === "bot") return messages[i]!.id;
    }
    return null;
  }, [messages]);

  const pickBestCandidate = React.useCallback((candidates: ContactCandidate[]): ContactCandidate | null => {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => {
      const at = typeof a?.lastActivityAt === "string" ? Date.parse(a.lastActivityAt) : NaN;
      const bt = typeof b?.lastActivityAt === "string" ? Date.parse(b.lastActivityAt) : NaN;
      const aTime = Number.isFinite(at) ? at : 0;
      const bTime = Number.isFinite(bt) ? bt : 0;
      return bTime - aTime;
    });
    return sorted[0] ?? null;
  }, []);

  const formatCandidateLabel = React.useCallback((candidate: ContactCandidate | null | undefined): string => {
    if (!candidate) return "";
    const name = (candidate.name ?? "").toString().trim();
    const phone = (candidate.phoneE164 ?? candidate.phone ?? "").toString().trim();
    const zip = (candidate.postalCode ?? "").toString().trim();
    return [name || null, phone || null, zip ? `(${zip})` : null].filter(Boolean).join(" ");
  }, []);

  const handleSend = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      setIsSending(true);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), sender: "user", text }]);
      setInput("");

      const payload = await callAssistant(
        text,
        defaultContextContact?.id ?? undefined,
        defaultContextProperty?.id ?? undefined,
        defaultContextProperty
          ? {
              addressLine1: defaultContextProperty.addressLine1,
              city: defaultContextProperty.city,
              state: defaultContextProperty.state,
              postalCode: defaultContextProperty.postalCode
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
              suggestions: payload.booking.suggestions,
              propertyLabel: payload.booking.propertyLabel
            }
          : undefined;
      const actions = payload?.actions && payload.actions.length ? payload.actions : undefined;

      if (actions && actions.length) {
        setActionStatuses((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (!next[action.id]) {
              next[action.id] = { state: "idle" };
            }
          }
          return next;
        });
        setActionServices((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (!next[action.id]) {
              const svc =
                Array.isArray(action.payload?.["services"]) && action.payload["services"].length
                  ? action.payload["services"][0]
                  : "junk_removal_primary";
              next[action.id] = svc;
            }
          }
          return next;
        });
        setActionNotes((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (!next[action.id]) {
              const prefill =
                typeof action.note === "string"
                  ? action.note
                  : typeof action.payload?.["notes"] === "string"
                    ? action.payload["notes"]
                    : typeof action.payload?.["note"] === "string"
                      ? action.payload["note"]
                      : typeof action.payload?.["body"] === "string"
                        ? action.payload["body"]
                        : "";
              next[action.id] = prefill ?? "";
            }
          }
          return next;
        });
        setActionReminderTitle((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (action.type !== "create_reminder" || next[action.id]) continue;
            const title =
              typeof action.payload?.["title"] === "string" && action.payload["title"].trim().length
                ? action.payload["title"].trim()
                : "Call back";
            next[action.id] = title;
          }
          return next;
        });
        setActionReminderDate((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (action.type !== "create_reminder" || next[action.id]) continue;
            const dueAt = typeof action.payload?.["dueAt"] === "string" ? action.payload["dueAt"] : "";
            const date = dueAt ? new Date(dueAt) : null;
            next[action.id] =
              date && !Number.isNaN(date.getTime())
                ? date.toLocaleDateString("en-CA", { timeZone: TEAM_TIME_ZONE })
                : "";
          }
          return next;
        });
        setActionReminderTime((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (action.type !== "create_reminder" || next[action.id]) continue;
            const dueAt = typeof action.payload?.["dueAt"] === "string" ? action.payload["dueAt"] : "";
            const date = dueAt ? new Date(dueAt) : null;
            next[action.id] =
              date && !Number.isNaN(date.getTime())
                ? date.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: TEAM_TIME_ZONE
                  })
                : "";
          }
          return next;
        });
        setActionDurations((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if ((action.type === "book_appointment" || action.type === "reschedule_appointment") && !next[action.id]) {
              next[action.id] =
                typeof action.payload?.["durationMinutes"] === "number" && action.payload["durationMinutes"] > 0
                  ? action.payload["durationMinutes"]
                  : 60;
            }
          }
          return next;
        });
        setActionTravel((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if ((action.type === "book_appointment" || action.type === "reschedule_appointment") && !next[action.id]) {
              next[action.id] =
                typeof action.payload?.["travelBufferMinutes"] === "number" && action.payload["travelBufferMinutes"] >= 0
                  ? action.payload["travelBufferMinutes"]
                  : 30;
            }
          }
          return next;
        });
        setActionStartDate((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if ((action.type === "book_appointment" || action.type === "reschedule_appointment") && !next[action.id]) {
              const start = action.payload?.["startAt"] ? new Date(action.payload["startAt"]) : null;
              next[action.id] = start ? start.toISOString().slice(0, 10) : "";
            }
          }
          return next;
        });
        setActionStartTime((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if ((action.type === "book_appointment" || action.type === "reschedule_appointment") && !next[action.id]) {
              const start = action.payload?.["startAt"] ? new Date(action.payload["startAt"]) : null;
              next[action.id] = start
                ? start.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                    timeZone: TEAM_TIME_ZONE
                  })
                : "";
            }
          }
          return next;
        });

        setActionPickedContacts((prev) => {
          const next = { ...prev };
          for (const action of actions) {
            if (next[action.id]) continue;
            const requiresContact = action.type === "send_text" || action.type === "book_appointment";
            const hasContactId = typeof action.payload?.["contactId"] === "string" && action.payload["contactId"].trim().length > 0;
            if (!requiresContact || hasContactId) continue;
            const candidates = Array.isArray(action.payload?.["contactCandidates"])
              ? (action.payload["contactCandidates"] as ContactCandidate[])
              : [];
            const best = pickBestCandidate(candidates);
            if (best) next[action.id] = best;
          }
          return next;
        });
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sender: "bot",
          text: combinedReply,
          ...(booking ? { booking } : {}),
          ...(actions ? { actions } : {})
        }
      ]);
      lastBotMessageRef.current = combinedReply;
      setIsSending(false);
    },
    [defaultContextContact, defaultContextProperty, isSending, pickBestCandidate]
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
      setIsTranscribing(true);
      stopRecording();
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
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        try {
          await uploadAudio(blob);
        } finally {
          stream.getTracks().forEach((t) => t.stop());
          setIsRecording(false);
          setIsTranscribing(false);
        }
      };
      mr.onerror = () => {
        setIsRecording(false);
        setIsTranscribing(false);
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      setIsTranscribing(false);
      mr.start();
    } catch {
      setIsRecording(false);
      setIsTranscribing(false);
    }
  }, [supportsRecording, isRecording, stopRecording, uploadAudio]);

  const handleSpeak = React.useCallback(async (override?: string) => {
    const text = (override ?? lastBotMessageRef.current).trim();
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
    return `${start.toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: TEAM_TIME_ZONE
    })} - ${end.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TEAM_TIME_ZONE
    })}`;
  }, []);

  const handleBook = React.useCallback(
    async (booking: NonNullable<Message["booking"]>, suggestion: BookingOption) => {
      if (bookingInFlight) return;
      const contact = contacts.find((c) => c.id === booking.contactId);
      const property = contact?.properties.find((p) => p.id === booking.propertyId);
      const confirmLabel = `${formatSlot(suggestion)}${property ? ` at ${property.label}` : ""}`;
      setBookingStatus({ state: "confirming", label: confirmLabel });
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
            services:
              suggestion.selectedService && suggestion.selectedService.length
                ? [suggestion.selectedService]
                : suggestion.services && suggestion.services.length
                  ? suggestion.services
                  : ["junk_removal_primary"]
          })
        });
        if (!res.ok) {
          const errText = await res.text();
          setBookingStatus({
            state: "error",
            message: `Booking failed (HTTP ${res.status}): ${errText.slice(0, 160)}`
          });
        } else {
          const data = (await res.json()) as { appointmentId?: string; startAt?: string };
          const when = data.startAt
            ? new Date(data.startAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })
            : formatSlot(suggestion);
          setBookingStatus({
            state: "success",
            message: `Booked ${when}${contact ? ` for ${contact.name}` : ""}${property ? ` at ${property.label}` : ""}.`
          });
        }
      } catch (error) {
        setBookingStatus({
          state: "error",
          message: `Booking request failed: ${(error as Error).message}`
        });
      } finally {
        setBookingInFlight(false);
      }
    },
    [bookingInFlight, contacts, formatSlot]
  );

  const handleActionDismiss = React.useCallback((messageId: string, actionId: string) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, actions: msg.actions?.filter((action) => action.id !== actionId) ?? [] }
          : msg
      )
    );
    setActionStatuses((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
  }, []);

  const handleActionConfirm = React.useCallback(
    async (action: ActionSuggestion) => {
      setActionStatuses((prev) => ({ ...prev, [action.id]: { state: "running" } }));
      try {
        const payload = { ...action.payload };
        const picked = actionPickedContacts[action.id];
        if (picked && typeof picked.id === "string" && picked.id.trim().length > 0) {
          payload["contactId"] = picked.id.trim();
          const label = formatCandidateLabel(picked);
          if (label) payload["contactLabel"] = label;
          if ("contactCandidates" in payload) delete payload["contactCandidates"];
        }
        if (action.type === "send_text" || action.type === "book_appointment") {
          if (typeof payload["contactId"] !== "string" || !payload["contactId"].trim().length) {
            setActionStatuses((prev) => ({
              ...prev,
              [action.id]: { state: "error", message: "Pick the correct contact first." }
            }));
            return;
          }
        }
        const note = actionNotes[action.id]?.trim();
        if (note && note.length > 0) {
          if (action.type === "send_text") {
            payload["body"] = note;
          } else if (action.type === "add_contact_note") {
            payload["body"] = note;
          } else if (action.type === "create_reminder") {
            payload["notes"] = note;
          } else {
            payload["note"] = note;
            if (action.type === "create_quote") {
              payload["notes"] = note;
            }
          }
        }
        if (action.type === "create_reminder") {
          const title = actionReminderTitle[action.id]?.trim();
          if (title && title.length) {
            payload["title"] = title;
          }
          const datePart = actionReminderDate[action.id];
          const timePart = actionReminderTime[action.id];
          if (datePart) {
            const iso = timePart ? `${datePart}T${timePart}:00` : `${datePart}T09:00:00`;
            payload["dueAt"] = new Date(iso).toISOString();
          }
        }
        if (action.type === "book_appointment") {
          const selected = actionServices[action.id];
          payload["services"] =
            selected && selected.length
              ? [selected]
              : Array.isArray(action.payload?.["services"]) && action.payload["services"].length
                ? action.payload["services"]
                : ["junk_removal_primary"];
          const chosenDuration = actionDurations[action.id];
          payload["durationMinutes"] =
            typeof chosenDuration === "number" && chosenDuration > 0
              ? chosenDuration
              : action.payload?.["durationMinutes"] ?? 60;
          const chosenTravel = actionTravel[action.id];
          payload["travelBufferMinutes"] =
            typeof chosenTravel === "number" && chosenTravel >= 0
              ? chosenTravel
              : action.payload?.["travelBufferMinutes"] ?? 30;
          const datePart = actionStartDate[action.id];
          const timePart = actionStartTime[action.id];
          if (datePart) {
            const iso = timePart ? `${datePart}T${timePart}:00` : `${datePart}T09:00:00`;
            payload["startAt"] = new Date(iso).toISOString();
          }
        }
        if (action.type === "reschedule_appointment") {
          const chosenDuration = actionDurations[action.id];
          payload["durationMinutes"] =
            typeof chosenDuration === "number" && chosenDuration > 0
              ? chosenDuration
              : action.payload?.["durationMinutes"] ?? 60;
          const chosenTravel = actionTravel[action.id];
          payload["travelBufferMinutes"] =
            typeof chosenTravel === "number" && chosenTravel >= 0
              ? chosenTravel
              : action.payload?.["travelBufferMinutes"] ?? 30;
          const datePart = actionStartDate[action.id];
          const timePart = actionStartTime[action.id];
          if (datePart) {
            const iso = timePart ? `${datePart}T${timePart}:00` : `${datePart}T09:00:00`;
            payload["startAt"] = new Date(iso).toISOString();
          }
        }
        const res = await fetch("/api/chat/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: action.type, payload })
        });
        if (!res.ok) {
          const detail = await res.text();
          setActionStatuses((prev) => ({
            ...prev,
            [action.id]: { state: "error", message: `Action failed (HTTP ${res.status}): ${detail.slice(0, 140)}` }
          }));
          setActionHistory((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              summary: `Action error: ${action.summary}`,
              status: "error",
              message: `Action failed (HTTP ${res.status})`
            }
          ]);
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { result?: { summary?: string; appointmentId?: string } };
        const summary =
          data?.result && typeof data.result === "object"
            ? (data.result as any).summary ?? "Action completed"
            : "Action completed";
        setActionStatuses((prev) => ({
          ...prev,
          [action.id]: { state: "success", message: summary }
        }));
        setActionHistory((prev) => [...prev.slice(-6), { id: action.id, summary: action.summary, status: "success", message: summary }]);
        if (action.type === "book_appointment") {
          const appointmentId = (data?.result as any)?.appointmentId;
          if (appointmentId) {
            setLastBooked({ appointmentId, message: summary });
          }
        }
      } catch (error) {
        setActionStatuses((prev) => ({
          ...prev,
          [action.id]: { state: "error", message: `Action request failed: ${(error as Error).message}` }
        }));
        setActionHistory((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            summary: `Action error: ${action.summary}`,
            status: "error",
            message: `Action failed: ${(error as Error).message}`
          }
        ]);
      }
    },
    [
      actionPickedContacts,
      formatCandidateLabel,
      actionNotes,
      actionDurations,
      actionServices,
      actionTravel,
      actionStartDate,
      actionStartTime,
      actionReminderDate,
      actionReminderTime,
      actionReminderTitle
    ]
  );

  const handleUndoBooking = React.useCallback(async () => {
    if (!lastBooked) return;
    setUndoStatus({ state: "running" });
    try {
      const res = await fetch("/api/chat/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "cancel_appointment", payload: { appointmentId: lastBooked.appointmentId } })
      });
      if (!res.ok) {
        const detail = await res.text();
        setUndoStatus({ state: "error", message: `Cancel failed (HTTP ${res.status}): ${detail.slice(0, 140)}` });
        return;
      }
      setUndoStatus({ state: "success", message: "Appointment canceled" });
      setActionHistory((prev) => [
        ...prev,
        { id: crypto.randomUUID(), summary: "Undo booking", status: "success", message: "Appointment canceled" }
      ]);
      setLastBooked(null);
    } catch (error) {
      setUndoStatus({ state: "error", message: `Cancel failed: ${(error as Error).message}` });
    }
  }, [lastBooked]);

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <header className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Stonegate Agent</h2>
            <p className="text-sm text-slate-500">
              Ask questions or request actions. The agent proposes changes and waits for your confirmation before executing.
            </p>
          </div>
        </header>

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
                {message.sender === "bot" && message.id === lastBotMessageId ? (
                  <div className="flex items-center">
                    <Button type="button" size="sm" variant="ghost" onClick={() => void handleSpeak(message.text)}>
                      Listen
                    </Button>
                  </div>
                ) : null}

                {message.booking ? (
                  <div className="space-y-2 rounded-xl border border-primary-50 bg-primary-50/60 px-3 py-2">
                    {message.booking.propertyLabel ? (
                      <div className="text-[11px] font-semibold text-primary-800">Property: {message.booking.propertyLabel}</div>
                    ) : null}
                    <div className="flex flex-wrap gap-3 text-xs text-slate-700">
                      {message.booking.suggestions.map((suggestion, idx) => {
                        const selected = suggestion.selectedService ?? (suggestion.services?.[0] ?? "junk_removal_primary");
                        return (
                          <div
                            key={`${message.id}-sugg-${idx}`}
                            className="flex items-center gap-2 rounded-lg border border-primary-100 bg-white px-2 py-1 shadow-sm"
                          >
                            <button
                              type="button"
                              onClick={() => void handleBook(message.booking!, { ...suggestion, selectedService: selected })}
                              disabled={bookingInFlight}
                              className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                              title={suggestion.reason}
                            >
                              {formatSlot(suggestion)}
                            </button>
                            <select
                              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700 focus:border-primary-400 focus:outline-none"
                              value={selected}
                              onChange={(e) => {
                                const next = e.target.value;
                                message.booking!.suggestions = message.booking!.suggestions.map((s, i) =>
                                  i === idx ? { ...s, selectedService: next } : s
                                );
                              }}
                            >
                              {(suggestion.services && suggestion.services.length
                                ? suggestion.services
                                : ["junk_removal_primary"]
                              ).map((svc) => (
                                <option key={svc} value={svc}>
                                  {formatServiceLabel(svc)}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                    {bookingStatus.state !== "idle" ? (
                      <div className="text-[11px] text-slate-600">
                        {bookingStatus.state === "confirming" ? (
                          <span className="inline-flex items-center gap-2 text-amber-700">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                            Booking {bookingStatus.label}...
                          </span>
                        ) : bookingStatus.state === "success" ? (
                          <span className="inline-flex items-center gap-2 text-emerald-700">
                            <span className="h-2 w-2 rounded-full bg-emerald-400" />
                            {bookingStatus.message}
                          </span>
                        ) : bookingStatus.state === "error" ? (
                          <span className="inline-flex items-center gap-2 text-rose-700">
                            <span className="h-2 w-2 rounded-full bg-rose-400" />
                            {bookingStatus.message}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {message.actions && message.actions.length ? (
                  <div className="space-y-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Actions</div>
                      {message.actions.map((action) => {
                        const status = actionStatuses[action.id]?.state ?? "idle";
                        const statusMessage = (actionStatuses[action.id] as any)?.message as string | undefined;
                        const requiresContact = action.type === "send_text" || action.type === "book_appointment";
                        const hasContactId =
                          typeof action.payload?.["contactId"] === "string" && action.payload["contactId"].trim().length > 0;
                        const pickedId = actionPickedContacts[action.id]?.id?.trim?.() ?? "";
                        const hasPicked = typeof pickedId === "string" && pickedId.trim().length > 0;
                        const needsContactPick = requiresContact && !hasContactId && !hasPicked;
                        return (
                        <div
                          key={action.id}
                          className="flex flex-col gap-2 rounded-lg border border-slate-100 bg-slate-50/80 px-2 py-2 text-xs text-slate-700"
                        >
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                            <div className="font-semibold text-slate-800">{action.summary}</div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void handleActionConfirm(action)}
                                disabled={status === "running" || status === "success" || needsContactPick}
                                className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-[11px] font-semibold text-primary-800 transition hover:border-primary-300 hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {status === "running" ? "Working..." : status === "success" ? "Done" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleActionDismiss(message.id, action.id)}
                                disabled={status === "running"}
                                className="rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                          {action.type === "book_appointment" ? (
                            <div className="grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
                              {(() => {
                                const candidates = Array.isArray(action.payload?.["contactCandidates"])
                                  ? (action.payload["contactCandidates"] as ContactCandidate[])
                                  : [];
                                const hasContactId =
                                  typeof action.payload?.["contactId"] === "string" && action.payload["contactId"].trim().length > 0;
                                if (hasContactId || candidates.length === 0) return null;
                                const picked = actionPickedContacts[action.id];
                                if (!picked) {
                                  return (
                                    <div className="space-y-2 sm:col-span-3">
                                      <div className="text-[11px] font-semibold text-slate-700">Pick contact</div>
                                      <div className="flex flex-wrap gap-2">
                                        {candidates.map((candidate) => {
                                          const label = formatCandidateLabel(candidate) || candidate.id;
                                          return (
                                            <button
                                              key={candidate.id ?? label}
                                              type="button"
                                              className={cn(
                                                "rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-slate-300"
                                              )}
                                              onClick={() =>
                                                setActionPickedContacts((prev) => ({
                                                  ...prev,
                                                  [action.id]: candidate
                                                }))
                                              }
                                            >
                                              {label}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div className="space-y-2 sm:col-span-3">
                                    <div className="text-[11px] text-slate-500">For: {formatCandidateLabel(picked)}</div>
                                    <details className="rounded-md border border-slate-200 bg-white px-2 py-2">
                                      <summary className="cursor-pointer select-none text-[11px] font-semibold text-slate-600">
                                        Change contact
                                      </summary>
                                      <div className="mt-2 flex flex-wrap gap-2">
                                        {candidates.map((candidate) => {
                                          const label = formatCandidateLabel(candidate) || candidate.id;
                                          const isPicked = picked?.id && candidate.id && picked.id === candidate.id;
                                          return (
                                            <button
                                              key={candidate.id ?? label}
                                              type="button"
                                              className={cn(
                                                "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
                                                isPicked
                                                  ? "border-primary-300 bg-primary-100 text-primary-900"
                                                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                                              )}
                                              onClick={() =>
                                                setActionPickedContacts((prev) => ({
                                                  ...prev,
                                                  [action.id]: candidate
                                                }))
                                              }
                                            >
                                              {label}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </details>
                                  </div>
                                );
                              })()}
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Service</span>
                                <select
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionServices[action.id] ?? "junk_removal_primary"}
                                  onChange={(e) =>
                                    setActionServices((prev) => ({ ...prev, [action.id]: e.target.value }))
                                  }
                                >
                                  {(Array.isArray(action.payload?.["services"]) && action.payload["services"].length
                                    ? action.payload["services"]
                                    : ["junk_removal_primary"]
                                  ).map((svc) => (
                                    <option key={svc} value={svc}>
                                      {svc.replace(/_/g, " ")}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Duration (min)</span>
                                <input
                                  type="number"
                                  min={15}
                                  max={240}
                                  step={15}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionDurations[action.id] ?? 60}
                                  onChange={(e) =>
                                    setActionDurations((prev) => ({
                                      ...prev,
                                      [action.id]: Number(e.target.value)
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Travel buffer (min)</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={180}
                                  step={10}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionTravel[action.id] ?? 30}
                                  onChange={(e) =>
                                    setActionTravel((prev) => ({
                                      ...prev,
                                      [action.id]: Number(e.target.value)
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Start date</span>
                                <input
                                  type="date"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionStartDate[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionStartDate((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Start time</span>
                                <input
                                  type="time"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionStartTime[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionStartTime((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1 sm:col-span-3">
                                <span className="font-semibold text-slate-700">Booking note (optional)</span>
                                <textarea
                                  rows={2}
                                  className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionNotes[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionNotes((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                  placeholder="Add a short note for this booking"
                                />
                              </label>
                            </div>
                          ) : null}
                          {action.type === "reschedule_appointment" ? (
                            <div className="grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
                              <label className="flex flex-col gap-1 sm:col-span-2">
                                <span className="font-semibold text-slate-700">New date</span>
                                <input
                                  type="date"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionStartDate[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionStartDate((prev) => ({ ...prev, [action.id]: e.target.value }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Time</span>
                                <input
                                  type="time"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionStartTime[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionStartTime((prev) => ({ ...prev, [action.id]: e.target.value }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Duration (min)</span>
                                <input
                                  type="number"
                                  min={15}
                                  max={240}
                                  step={15}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionDurations[action.id] ?? 60}
                                  onChange={(e) =>
                                    setActionDurations((prev) => ({
                                      ...prev,
                                      [action.id]: Number(e.target.value)
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Travel buffer (min)</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={180}
                                  step={5}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionTravel[action.id] ?? 30}
                                  onChange={(e) =>
                                    setActionTravel((prev) => ({
                                      ...prev,
                                      [action.id]: Number(e.target.value)
                                    }))
                                  }
                                />
                              </label>
                            </div>
                          ) : null}
                          {action.type === "send_text" ? (
                            <div className="grid gap-2 text-[11px] text-slate-600">
                              {(() => {
                                const candidates = Array.isArray(action.payload?.["contactCandidates"])
                                  ? (action.payload["contactCandidates"] as ContactCandidate[])
                                  : [];
                                const hasContactId =
                                  typeof action.payload?.["contactId"] === "string" && action.payload["contactId"].trim().length > 0;
                                if (hasContactId || candidates.length === 0) return null;
                                const picked = actionPickedContacts[action.id];
                                if (!picked) {
                                  return (
                                    <div className="space-y-2">
                                      <div className="text-[11px] font-semibold text-slate-700">Pick contact</div>
                                      <div className="flex flex-wrap gap-2">
                                        {candidates.map((candidate) => {
                                          const label = formatCandidateLabel(candidate) || candidate.id;
                                          return (
                                            <button
                                              key={candidate.id ?? label}
                                              type="button"
                                              className={cn(
                                                "rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-slate-300"
                                              )}
                                              onClick={() =>
                                                setActionPickedContacts((prev) => ({
                                                  ...prev,
                                                  [action.id]: candidate
                                                }))
                                              }
                                            >
                                              {label}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <details className="rounded-md border border-slate-200 bg-white px-2 py-2">
                                    <summary className="cursor-pointer select-none text-[11px] font-semibold text-slate-600">
                                      Change contact
                                    </summary>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {candidates.map((candidate) => {
                                        const label = formatCandidateLabel(candidate) || candidate.id;
                                        const isPicked = picked?.id && candidate.id && picked.id === candidate.id;
                                        return (
                                          <button
                                            key={candidate.id ?? label}
                                            type="button"
                                            className={cn(
                                              "rounded-full border px-3 py-1 text-[11px] font-semibold transition",
                                              isPicked
                                                ? "border-primary-300 bg-primary-100 text-primary-900"
                                                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                                            )}
                                            onClick={() =>
                                              setActionPickedContacts((prev) => ({
                                                ...prev,
                                                [action.id]: candidate
                                              }))
                                            }
                                          >
                                            {label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </details>
                                );
                              })()}
                              {(() => {
                                const payloadLabel =
                                  typeof action.payload?.["contactLabel"] === "string" ? action.payload["contactLabel"].trim() : "";
                                const pickedLabel = formatCandidateLabel(actionPickedContacts[action.id]);
                                const label = payloadLabel.length ? payloadLabel : pickedLabel;
                                return label ? <div className="text-[11px] text-slate-500">To: {label}</div> : null;
                              })()}
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Text message (SMS)</span>
                                <textarea
                                  rows={3}
                                  className="w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px]"
                                  value={actionNotes[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionNotes((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                  placeholder="Type the SMS you want to send"
                                />
                              </label>
                            </div>
                          ) : null}
                          {action.type === "create_reminder" ? (
                            <div className="grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Due date</span>
                                <input
                                  type="date"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionReminderDate[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionReminderDate((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Due time</span>
                                <input
                                  type="time"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionReminderTime[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionReminderTime((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="font-semibold text-slate-700">Title</span>
                                <input
                                  type="text"
                                  className="rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionReminderTitle[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionReminderTitle((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                  placeholder="Call back"
                                />
                              </label>
                              <label className="flex flex-col gap-1 sm:col-span-3">
                                <span className="font-semibold text-slate-700">Notes (optional)</span>
                                <textarea
                                  rows={2}
                                  className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                  value={actionNotes[action.id] ?? ""}
                                  onChange={(e) =>
                                    setActionNotes((prev) => ({
                                      ...prev,
                                      [action.id]: e.target.value
                                    }))
                                  }
                                  placeholder="Add context for the reminder"
                                />
                              </label>
                            </div>
                          ) : null}
                          {action.type === "add_contact_note" ? (
                            <div className="flex flex-col gap-1 text-[11px] text-slate-600">
                              <span className="font-semibold text-slate-700">Note (required)</span>
                              <textarea
                                rows={3}
                                className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                value={actionNotes[action.id] ?? ""}
                                onChange={(e) =>
                                  setActionNotes((prev) => ({
                                    ...prev,
                                    [action.id]: e.target.value
                                  }))
                                }
                                placeholder="Add a note to this contact"
                              />
                            </div>
                          ) : null}
                          {action.type === "create_quote" || action.type === "create_task" ? (
                            <div className="flex flex-col gap-1 text-[11px] text-slate-600">
                              <span className="font-semibold text-slate-700">Add note (optional)</span>
                              <textarea
                                rows={2}
                                className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px]"
                                value={actionNotes[action.id] ?? ""}
                                onChange={(e) =>
                                  setActionNotes((prev) => ({
                                    ...prev,
                                    [action.id]: e.target.value
                                  }))
                                }
                                placeholder="Short note for this action"
                              />
                            </div>
                          ) : null}
                          {action.context?.appointmentStartAt ? (
                            <div className="text-[11px] text-slate-500">
                              Appointment:{" "}
                              {action.context.appointmentStartAt
                                ? new Date(action.context.appointmentStartAt).toLocaleString(undefined, {
                                    timeZone: TEAM_TIME_ZONE
                                  })
                                : "Timing TBD"}
                            </div>
                          ) : null}
                          {status === "error" || status === "success" ? (
                            <div
                              className={`text-[11px] ${
                                status === "success" ? "text-emerald-700" : "text-rose-700"
                              }`}
                            >
                              {statusMessage ?? (status === "success" ? "Completed" : "Action failed")}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))}
            {lastBooked ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">Booked: {lastBooked.message}</span>
                  <button
                    type="button"
                    onClick={() => void handleUndoBooking()}
                    disabled={undoStatus.state === "running"}
                    className="rounded-full border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800 hover:border-amber-400 disabled:opacity-60"
                  >
                    {undoStatus.state === "running" ? "Canceling..." : "Undo booking"}
                  </button>
                </div>
                {undoStatus.state === "error" || undoStatus.state === "success" ? (
                  <div className="mt-1 text-[10px]">
                    {undoStatus.state === "success" ? "Canceled." : undoStatus.message ?? "Undo failed"}
                  </div>
                ) : null}
              </div>
            ) : null}

            {actionHistory.length ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-700">
                <div className="font-semibold text-slate-800">Recent actions</div>
                <ul className="mt-1 space-y-1">
                  {actionHistory.slice(-5).map((entry) => (
                    <li key={entry.id} className="flex items-start justify-between gap-2">
                      <span>{entry.summary}</span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                          entry.status === "success"
                            ? "bg-emerald-100 text-emerald-700"
                            : entry.status === "error"
                              ? "bg-rose-100 text-rose-700"
                              : "bg-slate-100 text-slate-600"
                        )}
                      >
                        {entry.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                placeholder="Type or talk..."
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
              <Button type="button" size="sm" disabled={!supportsRecording} onClick={handleMicToggle}>
                {supportsRecording ? (isRecording ? "Stop" : isTranscribing ? "Working..." : "Talk") : "No mic"}
              </Button>
              <Button type="submit" size="sm" disabled={isSending || isRecording || isTranscribing}>
                {isSending ? "Sending..." : "Send"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
