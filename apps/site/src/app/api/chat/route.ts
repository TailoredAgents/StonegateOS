import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";
import { formatServiceLabel } from "@/lib/service-labels";

const DEFAULT_BRAIN_MODEL = "gpt-5-mini";
const PUBLIC_VOICE_MODEL = "gpt-4.1-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const SYSTEM_PROMPT = `You are Stonegate Assist, the warm front-office voice for Stonegate Junk Removal in North Metro Atlanta. Think like a helpful local office rep, not a call script.

Principles:
- Keep replies short (usually 1-3 sentences). Use contractions and plain language. Sound natural, confident, and approachable.
- Reference only the services or details that fit the question. Typical offerings include: furniture removal, mattress disposal, appliance hauling, garage/attic cleanouts, yard waste, and light construction debris (no hazardous waste).
- Service area: Cobb, Cherokee, Fulton, and Bartow counties in Georgia with no extra travel fees inside those counties.
- Pricing: Stonegate pricing is STRICTLY based on trailer volume only. Never add charges for stairs, weight, difficulty, time, or urgency.
  Base volume prices: single item pickup $100, 1/4 trailer $175, 1/2 trailer $350, 3/4 trailer $525, full trailer $700.
  Big cleanouts can be multiple loads; speak in trailer-load tiers and ranges, and never promise an exact total.
  Extra disposal pass-through fees may apply for certain items (for example, mattresses/box springs are +$40 each).
- Process notes (use when relevant): licensed and insured two-person crews, careful in-home handling, responsible disposal and recycling when possible.
- Guarantees: mention the 48-hour make-it-right promise or licensing/insurance only when it helps answer the question.
- Scheduling: if the user asks to book, collect what you need (name, address, phone) and offer a couple of available 1-hour windows to choose from. Mention the "Schedule Estimate" page (/estimate) or call (404) 777-2631 only when the user asks about booking, timing, or next steps.
- Preparation tips (share only if asked): separate items for pickup, ensure clear pathways, and mention any mattresses/paint/tire quantities if they have them.
- Escalate politely to a human if the request is hazardous, urgent, or needs a firm commitment.
- Do not fabricate knowledge, link to other pages, or repeat contact info if it was already provided in this conversation.

Stay personable, concise, and helpful.`;

type OpenAIResponsesData = {
  output?: Array<{ content?: Array<{ text?: string }> }>;
  output_text?: string;
};

function extractOpenAIResponseText(data: OpenAIResponsesData): string {
  return (
    data.output_text?.trim() ??
    data.output
      ?.flatMap((item) => item?.content ?? [])
      ?.map((chunk) => chunk?.text ?? "")
      ?.filter((chunk) => typeof chunk === "string" && chunk.trim().length > 0)
      ?.join("\n")
      ?.trim() ??
    ""
  );
}

async function fetchOpenAIText(
  apiKey: string,
  payload: Record<string, unknown>,
  modelLabel: string
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    console.error(
      `[chat] OpenAI error for model '${modelLabel}' status ${response.status}: ${bodyText.slice(0, 300)}`
    );
    return { ok: false, status: response.status, error: bodyText };
  }

  const data = (await response.json()) as OpenAIResponsesData;
  const text = extractOpenAIResponseText(data);
  if (!text) {
    console.error(`[chat] OpenAI returned empty output for model '${modelLabel}'.`);
    return { ok: false, status: 502, error: "openai_empty" };
  }

  return { ok: true, text };
}

type BookingSuggestion = { startAt: string; endAt: string; reason: string; services?: string[] };

type BookingPayload = {
  contactId: string;
  propertyId: string;
  suggestions: BookingSuggestion[];
  propertyLabel?: string;
};

type ScheduleSummary = {
  ok: boolean;
  total: number;
  byStatus: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
};

type RevenueForecast = {
  ok: boolean;
  totalCents: number;
  currency: string | null;
  count: number;
};

type ChatRequest = {
  message?: string;
  contactId?: string;
  propertyId?: string;
  property?: {
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
  mode?: "team" | "public" | string;
  action?: { type?: string; startAt?: string } | null;
};

type CreateContactAction = {
  id: string;
  type: "create_contact";
  summary: string;
  payload: {
    contactName: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    addressLine2?: string | null;
    phone?: string | null;
    email?: string | null;
  };
};

type CreateQuoteAction = {
  id: string;
  type: "create_quote";
  summary: string;
  payload: {
    contactId: string;
    propertyId: string;
    services: string[];
    notes?: string | null;
    appointmentId?: string | null;
    zoneId?: string | null;
  };
};

type CreateTaskAction = {
  id: string;
  type: "create_task";
  summary: string;
  payload: {
    appointmentId: string;
    title: string;
  };
  context?: {
    appointmentStartAt?: string | null;
  };
};

type CreateBookingAction = {
  id: string;
  type: "book_appointment";
  summary: string;
  payload: {
    contactId: string;
    propertyId: string;
    startAt: string;
    durationMinutes?: number;
    travelBufferMinutes?: number;
    services?: string[];
    note?: string | null;
    quotedTotalCents?: number | null;
  };
  context?: {
    propertyLabel?: string;
  };
};

type SendTextAction = {
  id: string;
  type: "send_text";
  summary: string;
  payload: {
    contactId: string;
    body: string;
    channel?: "sms" | "dm" | "email";
  };
};

type RescheduleAppointmentAction = {
  id: string;
  type: "reschedule_appointment";
  summary: string;
  payload: {
    appointmentId: string;
    startAt: string;
    durationMinutes?: number;
    travelBufferMinutes?: number;
  };
};

type AddContactNoteAction = {
  id: string;
  type: "add_contact_note";
  summary: string;
  payload: {
    contactId: string;
    body: string;
  };
};

type CreateReminderAction = {
  id: string;
  type: "create_reminder";
  summary: string;
  payload: {
    contactId: string;
    title: string;
    dueAt: string;
    notes?: string | null;
    assignedTo?: string | null;
  };
};

type ActionSuggestion = (
  | CreateContactAction
  | CreateQuoteAction
  | CreateTaskAction
  | CreateBookingAction
  | SendTextAction
  | RescheduleAppointmentAction
  | AddContactNoteAction
  | CreateReminderAction
) & {
  note?: string | null;
};

type IntentClassification = {
  intent: "booking" | "contact" | "quote" | "task" | "none";
  contactName?: string;
  address?: string;
  services?: string[];
  note?: string;
  when?: string;
};

const CLASSIFIER_ENABLED = process.env["CHAT_CLASSIFIER_ENABLED"] !== "false";
const CHAT_ACTIONS_ENABLED = process.env["CHAT_ACTIONS_ENABLED"] !== "false";

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

function hasOwnerSession(request: NextRequest): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  return request.cookies.get(ADMIN_SESSION_COOKIE)?.value === adminKey;
}

const PUBLIC_BOOKING_COOKIE = "myst-public-booking";
const PUBLIC_BOOKING_COOKIE_MAX_AGE_S = 60 * 30; // 30 minutes

type PublicBookingPhase = "idle" | "awaiting_name" | "awaiting_address" | "awaiting_phone" | "suggesting";

type PublicBookingState = {
  phase: PublicBookingPhase;
  contactName?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  contactId?: string;
  propertyId?: string;
  suggestions?: Array<{ startAt: string; endAt: string }>;
  preferredDay?: string;
  preferredStartHour?: number;
  preferredEndHour?: number;
  preferenceLabel?: string;
  updatedAt?: number;
};

function bookingCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: PUBLIC_BOOKING_COOKIE_MAX_AGE_S
  };
}

function readPublicBookingState(request: NextRequest): PublicBookingState | null {
  const raw = request.cookies.get(PUBLIC_BOOKING_COOKIE)?.value;
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const phase = typeof parsed["phase"] === "string" ? (parsed["phase"] as string) : "idle";
  const allowed: PublicBookingPhase[] = ["idle", "awaiting_name", "awaiting_address", "awaiting_phone", "suggesting"];
  if (!allowed.includes(phase as PublicBookingPhase)) return null;

  const suggestionsRaw = parsed["suggestions"];
  const suggestions =
    Array.isArray(suggestionsRaw)
      ? suggestionsRaw
          .map((s) => ({
            startAt: typeof s?.["startAt"] === "string" ? s["startAt"] : "",
            endAt: typeof s?.["endAt"] === "string" ? s["endAt"] : ""
          }))
          .filter((s) => s.startAt.length > 0 && s.endAt.length > 0)
          .slice(0, 6)
      : undefined;

  return {
    phase: phase as PublicBookingPhase,
    contactName: typeof parsed["contactName"] === "string" ? parsed["contactName"] : undefined,
    phone: typeof parsed["phone"] === "string" ? parsed["phone"] : undefined,
    email: typeof parsed["email"] === "string" ? parsed["email"] : undefined,
    addressLine1: typeof parsed["addressLine1"] === "string" ? parsed["addressLine1"] : undefined,
    addressLine2: typeof parsed["addressLine2"] === "string" ? parsed["addressLine2"] : null,
    city: typeof parsed["city"] === "string" ? parsed["city"] : undefined,
    state: typeof parsed["state"] === "string" ? parsed["state"] : undefined,
    postalCode: typeof parsed["postalCode"] === "string" ? parsed["postalCode"] : undefined,
    contactId: typeof parsed["contactId"] === "string" ? parsed["contactId"] : undefined,
    propertyId: typeof parsed["propertyId"] === "string" ? parsed["propertyId"] : undefined,
    suggestions,
    preferredDay: typeof parsed["preferredDay"] === "string" ? parsed["preferredDay"] : undefined,
    preferredStartHour: typeof parsed["preferredStartHour"] === "number" ? parsed["preferredStartHour"] : undefined,
    preferredEndHour: typeof parsed["preferredEndHour"] === "number" ? parsed["preferredEndHour"] : undefined,
    preferenceLabel: typeof parsed["preferenceLabel"] === "string" ? parsed["preferenceLabel"] : undefined,
    updatedAt: typeof parsed["updatedAt"] === "number" ? parsed["updatedAt"] : undefined
  };
}

function writePublicBookingState(response: NextResponse, state: PublicBookingState | null) {
  if (!state) {
    response.cookies.set({ name: PUBLIC_BOOKING_COOKIE, value: "", path: "/", maxAge: 0 });
    return;
  }
  response.cookies.set(PUBLIC_BOOKING_COOKIE, JSON.stringify({ ...state, updatedAt: Date.now() }), bookingCookieOptions());
}

const BOOKING_TIME_ZONE = "America/New_York";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type BookingPreference = {
  preferredDay?: string;
  preferredStartHour?: number;
  preferredEndHour?: number;
  preferenceLabel?: string;
};

type BookingPreferenceUpdate = BookingPreference & {
  clear?: boolean;
};

function formatDayInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date
  );
}

function dayIndexInZone(date: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date).toLowerCase();
  const idx = WEEKDAYS.indexOf(label);
  return idx >= 0 ? idx : date.getDay();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function hourInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const parsed = hourPart ? Number(hourPart) : NaN;
  return Number.isFinite(parsed) ? parsed : date.getHours();
}

function extractPreferredDay(message: string, timeZone: string): { day: string; label: string } | null {
  const lower = message.toLowerCase();
  const now = new Date();
  if (lower.includes("today")) {
    return { day: formatDayInZone(now, timeZone), label: "today" };
  }
  if (lower.includes("tomorrow")) {
    return { day: formatDayInZone(addDays(now, 1), timeZone), label: "tomorrow" };
  }

  for (const [index, name] of WEEKDAYS.entries()) {
    if (!lower.includes(name)) continue;
    const currentIndex = dayIndexInZone(now, timeZone);
    const diff = (index - currentIndex + 7) % 7;
    return { day: formatDayInZone(addDays(now, diff), timeZone), label: name };
  }

  return null;
}

function extractPreferredTimeWindow(message: string): { startHour: number; endHour: number; label: string } | null {
  const lower = message.toLowerCase();
  if (lower.includes("morning") || lower.includes("early")) {
    return { startHour: 8, endHour: 12, label: "morning" };
  }
  if (lower.includes("afternoon")) {
    return { startHour: 12, endHour: 17, label: "afternoon" };
  }
  if (lower.includes("evening") || lower.includes("tonight") || lower.includes("after work")) {
    return { startHour: 17, endHour: 20, label: "evening" };
  }
  return null;
}

function looksLikeFlexibleTime(message: string): boolean {
  const lower = message.toLowerCase();
  return ["any time", "anytime", "whenever", "no preference", "no pref", "whatever works"].some((kw) =>
    lower.includes(kw)
  );
}

function extractBookingPreferenceUpdate(message: string, timeZone: string): BookingPreferenceUpdate | null {
  if (looksLikeFlexibleTime(message)) return { clear: true };

  const day = extractPreferredDay(message, timeZone);
  const window = extractPreferredTimeWindow(message);
  if (!day && !window) return null;

  const labelParts = [];
  if (day?.label) labelParts.push(day.label);
  if (window?.label) labelParts.push(window.label);

  return {
    preferredDay: day?.day,
    preferredStartHour: window?.startHour,
    preferredEndHour: window?.endHour,
    preferenceLabel: labelParts.length ? labelParts.join(" ") : undefined
  };
}

function applyBookingPreference(
  suggestions: BookingSuggestion[],
  preference: BookingPreference,
  timeZone: string
): { suggestions: BookingSuggestion[]; used: boolean } {
  const hasDay = typeof preference.preferredDay === "string" && preference.preferredDay.length > 0;
  const hasWindow =
    typeof preference.preferredStartHour === "number" &&
    Number.isFinite(preference.preferredStartHour) &&
    typeof preference.preferredEndHour === "number" &&
    Number.isFinite(preference.preferredEndHour);

  if (!hasDay && !hasWindow) return { suggestions, used: false };

  const filtered = suggestions.filter((slot) => {
    const start = new Date(slot.startAt);
    if (Number.isNaN(start.getTime())) return false;
    if (hasDay) {
      const day = formatDayInZone(start, timeZone);
      if (day !== preference.preferredDay) return false;
    }
    if (hasWindow) {
      const hour = hourInZone(start, timeZone);
      if (hour < (preference.preferredStartHour ?? 0) || hour >= (preference.preferredEndHour ?? 24)) return false;
    }
    return true;
  });

  return { suggestions: filtered, used: true };
}

function looksLikeBookingIntent(message: string): boolean {
  const lower = message.toLowerCase();
  return ["book", "schedule", "appointment", "estimate", "slot", "time", "tomorrow", "today"].some((kw) =>
    lower.includes(kw)
  );
}

function looksLikeCancelIntent(message: string): boolean {
  const lower = message.toLowerCase();
  return ["cancel", "never mind", "nevermind", "stop", "forget it", "start over", "reset"].some((kw) =>
    lower.includes(kw)
  );
}

function looksLikePricingQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("$")) return true;
  const keywords = [
    "how much",
    "price",
    "pricing",
    "cost",
    "quote",
    "estimate",
    "rate",
    "discount",
    "promo",
    "coupon",
    "percent",
    "fee",
    "fees",
    "mattress",
    "paint",
    "tire",
    "trailer",
    "load",
    "loads"
  ];
  return keywords.some((kw) => lower.includes(kw));
}

function normalizeLockedToken(token: string): string {
  return token.replace(/\s+/g, "").toLowerCase();
}

function extractLockedTokens(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\$\s*\d[\d,]*(?:\.\d+)?/g, // money
    /\b\d+(?:\.\d+)?\s*%/g, // percent
    /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, // times
    /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g // phone-like
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]?.trim();
      if (!raw) continue;
      out.add(normalizeLockedToken(raw));
    }
  }
  return Array.from(out);
}

function rewritePreservesLockedTokens(draft: string, rewritten: string): boolean {
  const required = extractLockedTokens(draft);
  if (!required.length) return true;
  const candidate = new Set(extractLockedTokens(rewritten));
  return required.every((token) => candidate.has(token));
}

function rewriteDoesNotIntroducePricingTokens(draft: string, rewritten: string): boolean {
  const draftPricing = new Set(
    Array.from(draft.matchAll(/\$\s*\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s*%/g)).map((m) =>
      normalizeLockedToken(m[0] ?? "")
    )
  );
  const rewrittenPricing = new Set(
    Array.from(rewritten.matchAll(/\$\s*\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s*%/g)).map((m) =>
      normalizeLockedToken(m[0] ?? "")
    )
  );
  for (const token of rewrittenPricing) {
    if (!draftPricing.has(token)) return false;
  }
  return true;
}

async function generatePublicFactualDraft(
  message: string,
  apiKey: string,
  model: string
): Promise<string | null> {
  const systemPrompt = `${SYSTEM_PROMPT}

Return ONLY JSON with the key "answerDraft".
- "answerDraft" must be short (1-3 sentences) and follow the pricing rules above exactly.
- Use $ amounts and ranges (never exact totals). Use $200 increments and allow multi-load ranges when relevant.
`.trim();

  const payload = {
    model,
    input: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message }
    ],
    reasoning: { effort: "low" as const },
    text: {
      verbosity: "low" as const,
      format: {
        type: "json_schema" as const,
        name: "public_answer_draft",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            answerDraft: { type: "string" }
          },
          required: ["answerDraft"]
        }
      }
    },
    max_output_tokens: 300
  };

  const res = await fetchOpenAIText(apiKey, payload, model);
  if (!res.ok) return null;

  const parsed = safeJsonParse(res.text);
  const draft = typeof parsed?.["answerDraft"] === "string" ? (parsed["answerDraft"] as string).trim() : "";
  return draft.length ? draft : null;
}

async function rewritePublicDraft(
  message: string,
  draft: string,
  apiKey: string
): Promise<string | null> {
  const systemPrompt = `You rewrite a draft response into a short, natural customer-service reply.
Rules:
- Do NOT change any numbers, $ amounts, percentages, times, phone numbers, or addresses.
- Do NOT introduce any new numbers or pricing.
- Keep it 1-3 sentences, friendly, and human.
- Output ONLY the rewritten text.`.trim();

  const payload = {
    model: PUBLIC_VOICE_MODEL,
    input: [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: `Customer message:\n${message}\n\nFactual draft to rewrite (do not change facts):\n${draft}`
      }
    ],
    reasoning: { effort: "low" as const },
    text: { verbosity: "low" as const },
    max_output_tokens: 220
  };

  const res = await fetchOpenAIText(apiKey, payload, PUBLIC_VOICE_MODEL);
  if (!res.ok) return null;
  const rewritten = res.text.trim();
  if (!rewritten) return null;
  if (!rewritePreservesLockedTokens(draft, rewritten)) return null;
  if (!rewriteDoesNotIntroducePricingTokens(draft, rewritten)) return null;
  return rewritten;
}

function fmtBookingTime(iso: string): string {
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "that time";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

async function createContactAndPropertyFromState(
  state: PublicBookingState
): Promise<{ contactId: string; propertyId: string } | null> {
  const { apiBase, adminKey } = getAdminContext();
  if (!adminKey) return null;

  const res = await fetch(`${apiBase}/api/admin/tools/contact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": adminKey
    },
    body: JSON.stringify({
      contactName: state.contactName,
      phone: state.phone,
      email: state.email,
      addressLine1: state.addressLine1,
      addressLine2: state.addressLine2 ?? undefined,
      city: state.city,
      state: state.state,
      postalCode: state.postalCode,
      source: "public_chat"
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn("[chat] public contact create failed", res.status, detail.slice(0, 160));
    return null;
  }

  const data = (await res.json().catch(() => ({}))) as { contactId?: string; propertyId?: string };
  const contactId = typeof data.contactId === "string" ? data.contactId : null;
  const propertyId = typeof data.propertyId === "string" ? data.propertyId : null;
  if (!contactId || !propertyId) return null;
  return { contactId, propertyId };
}

async function bookSlotForState(
  state: PublicBookingState,
  startAt: string
): Promise<{ ok: boolean; appointmentId?: string; startAt?: string; error?: string }> {
  const { apiBase, adminKey } = getAdminContext();
  if (!adminKey) return { ok: false, error: "admin_key_missing" };

  const res = await fetch(`${apiBase}/api/admin/booking/book`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": adminKey
    },
    body: JSON.stringify({
      contactId: state.contactId,
      propertyId: state.propertyId,
      startAt,
      durationMinutes: 60,
      travelBufferMinutes: 30,
      services: ["junk_removal_primary"]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn("[chat] public booking failed", res.status, detail.slice(0, 160));
    return { ok: false, error: `booking_failed_${res.status}` };
  }

  const data = (await res.json().catch(() => ({}))) as { appointmentId?: string; startAt?: string };
  return { ok: true, appointmentId: data.appointmentId, startAt: data.startAt };
}

function extractContactNameFromMessage(message: string): string | null {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const patterns = [
    /\bmy name is\s+([a-z][a-z' .-]{1,60})/i,
    /\bi am\s+([a-z][a-z' .-]{1,60})/i,
    /\bi'm\s+([a-z][a-z' .-]{1,60})/i,
    /\bthis is\s+([a-z][a-z' .-]{1,60})/i
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    if (candidate.length < 2 || candidate.length > 60) continue;
    if (/[0-9]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

function normalizeNameInput(message: string): string | null {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/[0-9]/.test(cleaned)) return null;
  if (cleaned.includes("@")) return null;
  if (cleaned.includes(",")) return null;
  return cleaned;
}

async function handlePublicBookingMessage(
  message: string,
  existingState: PublicBookingState | null
): Promise<{ reply: string; state: PublicBookingState | null; booking?: BookingPayload }> {
  if (looksLikeCancelIntent(message)) {
    return {
      reply: "No problem - I stopped the booking. If you want to schedule later, just say \"book me\".",
      state: null
    };
  }

  const state: PublicBookingState = existingState ?? { phase: "idle" };
  const preferenceUpdate = extractBookingPreferenceUpdate(message, BOOKING_TIME_ZONE);
  if (preferenceUpdate?.clear) {
    state.preferredDay = undefined;
    state.preferredStartHour = undefined;
    state.preferredEndHour = undefined;
    state.preferenceLabel = undefined;
  } else if (preferenceUpdate) {
    if (preferenceUpdate.preferredDay) state.preferredDay = preferenceUpdate.preferredDay;
    if (typeof preferenceUpdate.preferredStartHour === "number")
      state.preferredStartHour = preferenceUpdate.preferredStartHour;
    if (typeof preferenceUpdate.preferredEndHour === "number") state.preferredEndHour = preferenceUpdate.preferredEndHour;
    if (preferenceUpdate.preferenceLabel) state.preferenceLabel = preferenceUpdate.preferenceLabel;
  }

  const wantsNewSuggestions = Boolean(preferenceUpdate);

  if (state.phase === "suggesting" && state.suggestions?.length && !wantsNewSuggestions) {
    return {
      reply: "Tap one of the time buttons above and I'll lock it in.",
      state
    };
  }

  const email = extractEmailFromText(message);
  if (email && !state.email) {
    state.email = email;
  }

  const phone = extractPhoneFromText(message);
  if (phone && !state.phone) {
    state.phone = phone;
  }

  const parsedName = extractContactNameFromMessage(message);
  if (parsedName && !state.contactName) {
    state.contactName = parsedName;
  } else if (!state.contactName && state.phase === "awaiting_name") {
    const fallbackName = normalizeNameInput(message);
    if (fallbackName) {
      state.contactName = fallbackName;
    }
  }

  const parsedAddress = parseAddress(message) ?? (extractAddressFromMessage(message) ? parseAddress(extractAddressFromMessage(message)!) : null);
  if (parsedAddress) {
    state.addressLine1 = parsedAddress.addressLine1;
    state.addressLine2 = parsedAddress.addressLine2 ?? null;
    state.city = parsedAddress.city;
    state.state = parsedAddress.state;
    state.postalCode = parsedAddress.postalCode;
  }

  if (!state.contactName) {
    state.phase = "awaiting_name";
    return {
      reply: "Absolutely - what's your name?",
      state
    };
  }

  if (!state.addressLine1 || !state.city || !state.state || !state.postalCode) {
    state.phase = "awaiting_address";
    return {
      reply: `Thanks, ${state.contactName.split(" ")[0] ?? state.contactName}. What's the pickup address? (Street, City, ST ZIP)`,
      state
    };
  }

  if (!state.phone) {
    state.phase = "awaiting_phone";
    return {
      reply: "Perfect - what's the best phone number to confirm?",
      state
    };
  }

  if (!state.contactId || !state.propertyId) {
    const created = await createContactAndPropertyFromState(state);
    if (!created) {
      state.phase = "awaiting_address";
      return {
        reply: "Quick check - can you resend the address as Street, City, ST ZIP so I can lock this in?",
        state
      };
    }
    state.contactId = created.contactId;
    state.propertyId = created.propertyId;
  }

  const suggestions = await fetchBookingSuggestions({
    property: {
      addressLine1: state.addressLine1,
      city: state.city,
      state: state.state,
      postalCode: state.postalCode
    },
    preferredStartHour: state.preferredStartHour,
    preferredEndHour: state.preferredEndHour
  });

  if (!suggestions || !suggestions.length) {
    state.phase = "idle";
    return {
      reply: "I'm not seeing open times right now - want to try again, or would you rather call (404) 777-2631?",
      state
    };
  }

  state.phase = "suggesting";
  const preference: BookingPreference = {
    preferredDay: state.preferredDay,
    preferredStartHour: state.preferredStartHour,
    preferredEndHour: state.preferredEndHour,
    preferenceLabel: state.preferenceLabel
  };
  const filtered = applyBookingPreference(suggestions, preference, BOOKING_TIME_ZONE);
  const finalSuggestions = filtered.suggestions.length ? filtered.suggestions : suggestions;
  state.suggestions = finalSuggestions.map((s) => ({ startAt: s.startAt, endAt: s.endAt }));

  const label = state.preferenceLabel;
  const prefers = filtered.used;
  const reply = prefers
    ? filtered.suggestions.length
      ? label
        ? `Great - here are a few ${label} openings. Tap one to lock it in:`
        : "Great - here are a few openings that match that time. Tap one to lock it in:"
      : label
        ? `I couldn't find openings for ${label}, but here are the next available times:`
        : "I couldn't find openings for that time, but here are the next available times:"
    : "Awesome - here are a few openings. Tap one to lock it in:";

  return {
    reply,
    state,
    booking: {
      contactId: state.contactId,
      propertyId: state.propertyId,
      suggestions: finalSuggestions,
      propertyLabel: `${state.addressLine1}, ${state.city}`
    }
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ChatRequest;
    const message = typeof body.message === "string" ? body.message : "";
    const trimmedMessage = message.trim();
    const contactId = body.contactId;
    const propertyId = body.propertyId;
    const property = body.property;
    const requestedAudience = body.mode === "team" ? "team" : "public";
    const action = body.action ?? null;

    const audience = requestedAudience === "team" && hasOwnerSession(request) ? "team" : "public";
    const isTeamChat = audience === "team";

    if (audience === "public") {
      const actionType = typeof action?.type === "string" ? action.type : null;
      if (actionType === "reset_booking") {
        const res = NextResponse.json({ ok: true, reply: "Done - starting fresh. What can I help with?" });
        writePublicBookingState(res, null);
        return res;
      }

      if (actionType === "select_booking_slot") {
        const startAt = typeof action?.startAt === "string" ? action.startAt : "";
        const state = readPublicBookingState(request);
        const allowed = state?.suggestions?.some((s) => s.startAt === startAt) ?? false;
        if (!state || state.phase !== "suggesting" || !state.contactId || !state.propertyId || !allowed) {
          const res = NextResponse.json(
            { ok: false, error: "booking_state_missing", reply: "I don't have a slot queued up - say \"book me\" and I'll grab times again." },
            { status: 409 }
          );
          writePublicBookingState(res, null);
          return res;
        }

        const booked = await bookSlotForState(state, startAt);
        if (!booked.ok) {
          const res = NextResponse.json(
            {
              ok: false,
              error: booked.error ?? "booking_failed",
              reply: "That time just got snagged - want me to pull a few more options?"
            },
            { status: 409 }
          );
          writePublicBookingState(res, { ...state, phase: "idle", suggestions: undefined });
          return res;
        }

        const when = booked.startAt ? fmtBookingTime(booked.startAt) : fmtBookingTime(startAt);
        const confirmation = `You're booked for ${when}. We'll reach out shortly to confirm details.`;
        const res = NextResponse.json({ ok: true, reply: confirmation, booked: { appointmentId: booked.appointmentId, startAt: booked.startAt ?? startAt } });
        writePublicBookingState(res, null);
        return res;
      }

      const existing = readPublicBookingState(request);
      const inFlow = existing?.phase && existing.phase !== "idle";
      if (trimmedMessage && (inFlow || looksLikeBookingIntent(trimmedMessage))) {
        const result = await handlePublicBookingMessage(trimmedMessage, existing);
        const res = NextResponse.json({
          ok: true,
          reply: result.reply,
          ...(result.booking ? { booking: result.booking } : {})
        });
        writePublicBookingState(res, result.state);
        return res;
      }
    }

    if (!trimmedMessage) {
      return NextResponse.json({ error: "missing_message" }, { status: 400 });
    }

    const apiKey = process.env["OPENAI_API_KEY"];
    const brainModel = (process.env["OPENAI_MODEL"] ?? DEFAULT_BRAIN_MODEL).trim() || DEFAULT_BRAIN_MODEL;

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "openai_not_configured",
          message: "OpenAI API key not configured on the server"
        },
        { status: 503 }
      );
    }

    const teamContext = isTeamChat
      ? await buildTeamChatContext({
          contactId,
          propertyId,
          property
        })
      : null;

    const buildChatPayload = (modelName: string, extraSystem?: string | null) => ({
      model: modelName,
      input: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        ...(extraSystem ? ([{ role: "system" as const, content: extraSystem }] as const) : []),
        { role: "user" as const, content: trimmedMessage }
      ],
      reasoning: { effort: "low" as const },
      text: { verbosity: "low" as const },
      max_output_tokens: 400
    });

    if (!isTeamChat) {
      if (looksLikePricingQuestion(trimmedMessage)) {
        const draft = await generatePublicFactualDraft(trimmedMessage, apiKey, brainModel);
        if (draft) {
          const rewritten = await rewritePublicDraft(trimmedMessage, draft, apiKey);
          if (!rewritten) {
            console.warn("[chat] public pricing rewrite failed validation; using factual draft");
          }
          return NextResponse.json({ ok: true, reply: rewritten ?? draft });
        }

        console.warn("[chat] public pricing draft failed; falling back to brain model response");
        const res = await fetchOpenAIText(apiKey, buildChatPayload(brainModel, null), brainModel);
        if (!res.ok) {
          return NextResponse.json(
            {
              error: "openai_error",
              message: "Assistant is unavailable right now."
            },
            { status: 502 }
          );
        }
        return NextResponse.json({ ok: true, reply: res.text.trim() });
      }

      const voiceRes = await fetchOpenAIText(apiKey, buildChatPayload(PUBLIC_VOICE_MODEL, null), PUBLIC_VOICE_MODEL);
      if (voiceRes.ok) {
        return NextResponse.json({ ok: true, reply: voiceRes.text.trim() });
      }

      console.warn("[chat] public voice model failed; falling back to brain model");
      const brainRes = await fetchOpenAIText(apiKey, buildChatPayload(brainModel, null), brainModel);
      if (!brainRes.ok) {
        return NextResponse.json(
          {
            error: "openai_error",
            message: "Assistant is unavailable right now."
          },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, reply: brainRes.text.trim() });
    }

    const brainRes = await fetchOpenAIText(apiKey, buildChatPayload(brainModel, teamContext), brainModel);
    if (!brainRes.ok) {
      return NextResponse.json(
        {
          error: "openai_error",
          message: "Assistant is unavailable right now."
        },
        { status: 502 }
      );
    }

    const reply = brainRes.text.trim();

    const booking = await maybeGetSuggestions(trimmedMessage, {
      contactId,
      propertyId,
      property
    });
    const classification = CLASSIFIER_ENABLED ? await classifyIntent(trimmedMessage) : null;
    const wantsSchedule = looksLikeScheduleQuestion(trimmedMessage);
    const wantsRevenue = looksLikeRevenueQuestion(trimmedMessage);
    const range = wantsSchedule || wantsRevenue ? pickRange(trimmedMessage) : "this_week";

    const [scheduleText, revenueText] = await Promise.all([
      wantsSchedule ? fetchScheduleSummary(range, { statuses: ["confirmed"] }) : Promise.resolve(null),
      wantsRevenue ? fetchRevenueForecast(range) : Promise.resolve(null)
    ]);

    const actions = CHAT_ACTIONS_ENABLED
      ? await buildActionSuggestions(
          trimmedMessage,
          {
            contactId,
            propertyId,
            property
          },
          booking,
          classification,
          reply
        )
      : [];
    const actionNote = actions.length ? actions.map((action) => `Action: ${action.summary}`).join("\n") : null;

    const replyParts = [reply];
    if (scheduleText) replyParts.push(scheduleText);
    if (revenueText) replyParts.push(revenueText);

    const finalReply = replyParts.join("\n\n").trim();

    return NextResponse.json({
      ok: true,
      reply: finalReply,
      ...(booking ? { booking } : {}),
      ...(actions.length ? { actions } : {}),
      ...(actionNote ? { actionNote } : {})
    });
  } catch (error) {
    console.error("[chat] Server error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

async function maybeGetSuggestions(
  message: string,
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
    propertyLabel?: string;
  }
): Promise<BookingPayload | null> {
  const keywords = ["book", "schedule", "slot", "time", "appointment"];
  const lower = message.toLowerCase();
  if (!keywords.some((kw) => lower.includes(kw))) return null;
  if (!ctx.contactId || !ctx.propertyId) return null;

  const preferenceUpdate = extractBookingPreferenceUpdate(message, BOOKING_TIME_ZONE);
  const preference = preferenceUpdate?.clear ? null : preferenceUpdate;
  const suggestions = await fetchBookingSuggestions({
    ...ctx,
    preferredStartHour: preference?.preferredStartHour,
    preferredEndHour: preference?.preferredEndHour
  });
  if (!suggestions || !suggestions.length) return null;
  const filtered = preference
    ? applyBookingPreference(
        suggestions,
        {
          preferredDay: preference.preferredDay,
          preferredStartHour: preference.preferredStartHour,
          preferredEndHour: preference.preferredEndHour,
          preferenceLabel: preference.preferenceLabel
        },
        BOOKING_TIME_ZONE
      )
    : { suggestions, used: false };
  const finalSuggestions = filtered.suggestions.length ? filtered.suggestions : suggestions;
  return {
    contactId: ctx.contactId,
    propertyId: ctx.propertyId,
    suggestions: finalSuggestions,
    propertyLabel: ctx.propertyLabel
  };
}

async function fetchBookingSuggestions(
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
    preferredStartHour?: number;
    preferredEndHour?: number;
  }
): Promise<BookingSuggestion[] | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const body: {
      durationMinutes: number;
      startHour?: number;
      endHour?: number;
      addressLine1?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    } = { durationMinutes: 60 };

    if (ctx.property?.addressLine1) {
      body.addressLine1 = ctx.property.addressLine1;
      if (ctx.property.city) body.city = ctx.property.city;
      if (ctx.property.state) body.state = ctx.property.state;
      if (ctx.property.postalCode) body.postalCode = ctx.property.postalCode;
    }
    if (typeof ctx.preferredStartHour === "number" && Number.isFinite(ctx.preferredStartHour)) {
      body.startHour = ctx.preferredStartHour;
    }
    if (typeof ctx.preferredEndHour === "number" && Number.isFinite(ctx.preferredEndHour)) {
      body.endHour = ctx.preferredEndHour;
    }

    const res = await fetch(`${apiBase}/api/admin/booking/assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { suggestions?: Array<{ startAt?: string; endAt?: string; reason?: string }> };
    const suggestions =
      data.suggestions
        ?.slice(0, 3)
        .map((s) => ({
          startAt: typeof s.startAt === "string" ? s.startAt : "",
          endAt: typeof s.endAt === "string" ? s.endAt : "",
          reason: s.reason ?? "No conflicts"
        }))
        .filter((s) => s.startAt && s.endAt) ?? [];
    return suggestions;
  } catch (error) {
    console.warn("[chat] suggestion_fetch_failed", { error: String(error) });
    return null;
  }
}

function looksLikeScheduleQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ["schedule", "appointments", "jobs", "calendar", "booked", "slots", "week", "today", "tomorrow"];
  return keywords.some((kw) => lower.includes(kw));
}

function looksLikeRevenueQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ["revenue", "forecast", "sales", "booked out", "projected", "income", "today", "tomorrow"];
  return keywords.some((kw) => lower.includes(kw));
}

function fmtMoney(cents: number, currency: string | null): string {
  if (!Number.isFinite(cents)) return "$0";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function pickRange(message: string): "today" | "tomorrow" | "this_week" | "next_week" {
  const lower = message.toLowerCase();
  if (lower.includes("tomorrow")) return "tomorrow";
  if (lower.includes("today")) return "today";
  if (lower.includes("next week")) return "next_week";
  return "this_week";
}

function truncateText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLen - 1))}…`;
}

type TeamChatContext = {
  contactId?: string;
  propertyId?: string;
  property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
};

async function buildTeamChatContext(ctx: TeamChatContext): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  if (!ctx.contactId) {
    return [
      "You are assisting internal ops and office staff.",
      "Use the company policies and existing system behavior. If you are unsure, ask a clarifying question.",
      "Only discuss confirmed appointments when asked about scheduling."
    ].join("\n");
  }

  const contactId = ctx.contactId;
  const propertyLabel =
    ctx.property?.addressLine1 && ctx.property?.city && ctx.property?.state && ctx.property?.postalCode
      ? `${ctx.property.addressLine1}, ${ctx.property.city}, ${ctx.property.state} ${ctx.property.postalCode}`
      : null;

  const [taskRes, inboxRes, appt] = await Promise.all([
    fetch(`${apiBase}/api/admin/crm/tasks?contactId=${encodeURIComponent(contactId)}&status=all`, {
      headers: { "x-api-key": apiKey }
    }).catch(() => null),
    fetch(`${apiBase}/api/admin/inbox/threads?contactId=${encodeURIComponent(contactId)}&limit=3`, {
      headers: { "x-api-key": apiKey }
    }).catch(() => null),
    findAppointmentForContext(contactId, ctx.propertyId)
  ]);

  const notes: Array<{ body: string; createdAt?: string | null }> = [];
  const reminders: Array<{ title: string; dueAt: string | null; notes?: string | null }> = [];
  if (taskRes && taskRes.ok) {
    const data = (await taskRes.json().catch(() => null)) as { tasks?: Array<Record<string, unknown>> } | null;
    const tasks = Array.isArray(data?.tasks) ? data!.tasks : [];
    for (const task of tasks) {
      const status = typeof task["status"] === "string" ? task["status"] : null;
      const dueAt = typeof task["dueAt"] === "string" ? task["dueAt"] : null;
      const title = typeof task["title"] === "string" ? task["title"] : "";
      const body = typeof task["notes"] === "string" ? task["notes"] : null;

      if (status === "completed" && !dueAt && body && body.trim().length) {
        if (body.includes("[auto]")) continue;
        const createdAt = typeof task["createdAt"] === "string" ? task["createdAt"] : null;
        notes.push({ body: body.trim(), createdAt });
      }

      if (status === "open" && dueAt) {
        reminders.push({
          title: title.trim().length ? title.trim() : "Reminder",
          dueAt,
          notes: typeof task["notes"] === "string" ? task["notes"] : null
        });
      }
    }
  }

  notes.sort((a, b) => ((a.createdAt ?? "") > (b.createdAt ?? "") ? -1 : 1));
  reminders.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));

  const inboxSnippets: string[] = [];
  if (inboxRes && inboxRes.ok) {
    const data = (await inboxRes.json().catch(() => null)) as { threads?: Array<Record<string, unknown>> } | null;
    const threads = Array.isArray(data?.threads) ? data!.threads : [];
    for (const thread of threads.slice(0, 3)) {
      const channel = typeof thread["channel"] === "string" ? thread["channel"] : "unknown";
      const status = typeof thread["status"] === "string" ? thread["status"] : "unknown";
      const subject = typeof thread["subject"] === "string" ? thread["subject"] : null;
      const preview =
        typeof thread["lastMessagePreview"] === "string"
          ? thread["lastMessagePreview"]
          : typeof thread["resolvedLastMessagePreview"] === "string"
            ? thread["resolvedLastMessagePreview"]
            : null;
      const lastActivityAt = typeof thread["lastActivityAt"] === "string" ? thread["lastActivityAt"] : null;
      const prefix = `[${channel}/${status}]`;
      const subjectPart = subject && subject.trim().length ? ` ${truncateText(subject, 60)}` : "";
      const previewPart = preview && preview.trim().length ? ` — ${truncateText(preview, 120)}` : "";
      const atPart = lastActivityAt ? ` (${lastActivityAt})` : "";
      inboxSnippets.push(`${prefix}${subjectPart}${previewPart}${atPart}`.trim());
    }
  }

  const contextLines: string[] = [
    "You are assisting internal ops and office staff.",
    "Use the CRM context below. Be concise, actionable, and specific.",
    "Only use confirmed appointments for scheduling."
  ];

  contextLines.push(`Context contactId=${contactId}${propertyLabel ? ` property=${propertyLabel}` : ""}`);

  if (appt?.startAt) {
    contextLines.push(`Next confirmed appointment: ${appt.startAt}`);
  }

  if (notes.length) {
    contextLines.push("Recent notes:");
    for (const note of notes.slice(0, 3)) {
      contextLines.push(`- ${truncateText(note.body, 220)}`);
    }
  }

  if (reminders.length) {
    contextLines.push("Open reminders:");
    for (const reminder of reminders.slice(0, 3)) {
      const due = reminder.dueAt ? reminder.dueAt : "unscheduled";
      contextLines.push(`- ${truncateText(reminder.title, 60)} (due ${due})`);
    }
  }

  if (inboxSnippets.length) {
    contextLines.push("Recent inbox activity:");
    for (const snippet of inboxSnippets) {
      contextLines.push(`- ${snippet}`);
    }
  }

  return contextLines.join("\n");
}

async function fetchScheduleSummary(
  range: string,
  opts?: { statuses?: string[] }
): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const search = new URLSearchParams({ range });
    if (opts?.statuses?.length) {
      search.set("statuses", opts.statuses.join(","));
    }
    const res = await fetch(`${apiBase}/api/admin/schedule/summary?${search.toString()}`, {
      headers: {
        "x-api-key": apiKey
      }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ScheduleSummary;
    if (!data.ok) return null;
    const label =
      range === "today" ? "today" : range === "tomorrow" ? "tomorrow" : range === "next_week" ? "next week" : "this week";
    if (!data.total) return `Schedule ${label}: no appointments on the books.`;
    const statusParts = Object.entries(data.byStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const byDay = data.byDay
      .slice(0, 3)
      .map((d) => `${d.date}: ${d.count}`)
      .join(", ");
    return `Schedule ${label}: ${data.total} appointment(s)${statusParts ? ` (${statusParts})` : ""}${byDay ? `. Busiest days: ${byDay}` : ""}`;
  } catch (error) {
    console.warn("[chat] schedule_summary_failed", error);
    return null;
  }
}

async function fetchRevenueForecast(range: string): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const res = await fetch(`${apiBase}/api/admin/revenue/forecast?range=${encodeURIComponent(range)}`, {
      headers: {
        "x-api-key": apiKey
      }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RevenueForecast;
    if (!data.ok) return null;
    const label =
      range === "today" ? "today" : range === "tomorrow" ? "tomorrow" : range === "next_week" ? "next week" : "this week";
    return `Revenue ${label}: ${fmtMoney(data.totalCents, data.currency)} across ${data.count} payment(s).`;
  } catch (error) {
    console.warn("[chat] revenue_forecast_failed", error);
    return null;
  }
}

async function buildActionSuggestions(
  message: string,
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
  },
  booking?: BookingPayload | null,
  classification?: IntentClassification | null,
  replyText?: string | null
): Promise<ActionSuggestion[]> {
  const actions: ActionSuggestion[] = [];
  const note = extractActionNote(message) ?? classification?.note ?? null;
  const when = classification?.when;

  const contactAction = extractContactSuggestion(message, note, {
    contactName: classification?.contactName,
    address: classification?.address
  });
  if (contactAction) {
    actions.push(contactAction);
  }

  const quoteAction = extractQuoteSuggestion(message, ctx, note, classification?.services);
  if (quoteAction) {
    actions.push(quoteAction);
  }

  const taskAction = await extractTaskSuggestion(message, ctx, note);
  if (taskAction) {
    actions.push(taskAction);
  }

  const reminderAction = extractReminderSuggestion(message, ctx, note);
  if (reminderAction) {
    actions.push(reminderAction);
  }

  const contactNoteAction = extractContactNoteSuggestion(message, ctx, note);
  if (contactNoteAction) {
    actions.push(contactNoteAction);
  }

  const sendTextAction = extractSendTextSuggestion(message, ctx, replyText ?? null);
  if (sendTextAction) {
    actions.push(sendTextAction);
  }

  const rescheduleAction = extractRescheduleAppointmentSuggestion(message, when ?? null);
  if (rescheduleAction) {
    actions.push(rescheduleAction);
  }

  if (booking) {
    const bookingActions = buildBookingActions(booking, ctx, when, extractUsdToCents(message));
    actions.push(
      ...bookingActions.map((action) => ({
        ...action,
        ...(note ? { note } : {})
      }))
    );
  }

  return actions.slice(0, 3);
}

function extractSendTextSuggestion(
  message: string,
  ctx: { contactId?: string },
  replyText: string | null
): SendTextAction | null {
  if (!ctx.contactId) return null;
  const lower = message.toLowerCase();
  const wantsText =
    (lower.includes("text") || lower.includes("sms")) &&
    (lower.includes("send") || lower.includes("reply") || lower.includes("message"));
  if (!wantsText) return null;

  const explicit =
    extractQuotedContent(message) ??
    extractAfterKeyword(message, ["that says", "says", "text:", "sms:", "message:"]);
  const wantsGenerated = lower.includes("good reply") || lower.includes("good response");
  const generated = wantsGenerated ? pickSmsDraft(replyText) : null;
  const body = (explicit ?? generated ?? "").trim();
  if (!body) return null;

  const snippet = body.length > 42 ? `${body.slice(0, 42)}...` : body;
  return {
    id: newActionId(),
    type: "send_text",
    summary: `Send text: “${snippet}”`,
    payload: {
      contactId: ctx.contactId,
      body,
      channel: "sms"
    }
  };
}

function pickSmsDraft(replyText: string | null): string | null {
  if (!replyText) return null;
  const raw = replyText.trim();
  if (!raw) return null;

  const quoted = extractQuotedContent(raw);
  if (quoted) return quoted;

  const unfenced = raw
    .replace(/^```[\s\S]*?\n/, "")
    .replace(/\n```$/, "")
    .trim();

  const firstParagraph = unfenced.split(/\n\s*\n/)[0]?.trim() ?? "";
  const candidate = firstParagraph.length ? firstParagraph : unfenced;

  const cleaned = candidate
    .replace(/^(here(?:'s| is)\s+)?(a\s+)?(text|sms|message)\s*(you\s+can\s+send|to\s+send)\s*[:\-]\s*/i, "")
    .replace(/^(sure|ok|okay|got it)[\s,:\-]+/i, "")
    .trim();

  if (!cleaned) return null;
  return cleaned.slice(0, 480);
}

function extractRescheduleAppointmentSuggestion(message: string, whenHint: string | null): RescheduleAppointmentAction | null {
  const lower = message.toLowerCase();
  const hasIntent = lower.includes("reschedule") || lower.includes("move appointment") || lower.includes("change appointment");
  if (!hasIntent) return null;

  const appointmentId = extractUuidFromText(message);
  if (!appointmentId) return null;

  const when = (whenHint && whenHint.trim().length ? whenHint : message).trim();
  const parsed = parseWhen(when);
  if (!parsed?.iso) return null;

  return {
    id: newActionId(),
    type: "reschedule_appointment",
    summary: `Reschedule appointment to ${new Date(parsed.iso).toLocaleString()}`,
    payload: {
      appointmentId,
      startAt: parsed.iso
    }
  };
}

function extractQuotedContent(message: string): string | null {
  const match = message.match(/[“"']([^“"']{1,480})[”"']/);
  if (!match) return null;
  const text = (match[1] ?? "").trim();
  return text.length ? text : null;
}

function extractAfterKeyword(message: string, keywords: string[]): string | null {
  const lower = message.toLowerCase();
  for (const keyword of keywords) {
    const idx = lower.indexOf(keyword);
    if (idx === -1) continue;
    const raw = message.slice(idx + keyword.length).trim();
    if (raw.length) return raw.slice(0, 800);
  }
  return null;
}

function extractUuidFromText(text: string): string | null {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

function extractUsdToCents(message: string): number | null {
  const normalized = message.replace(/,/g, "");
  const match = normalized.match(/\$\s*(\d{1,6})(?:\.(\d{1,2}))?/);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  if (!Number.isFinite(cents) || cents < 0 || cents > 99) return null;
  return dollars * 100 + cents;
}

function extractContactSuggestion(
  message: string,
  note?: string | null,
  hints?: { contactName?: string | null; address?: string | null }
): CreateContactAction | null {
  const lower = message.toLowerCase();
  const intentMatch =
    /(add|new|create)\s+(a\s+)?contact/.test(lower) ||
    /(add|new|create)\s+[a-z]+\s+[a-z]+\s+(at|@)/i.test(message);
  if (!intentMatch) return null;

  const pattern = /contact\s+(.+?)\s+at\s+(.+)/i;
  const match = message.match(pattern);
  const contactName = (match?.[1]?.trim() ?? hints?.contactName ?? extractNameFallback(message)).trim();
  const addressRaw = match?.[2]?.trim() ?? hints?.address ?? extractAddressFromMessage(message);
  const address = addressRaw ? parseAddress(addressRaw) : null;

  if (!contactName.length || !address) {
    return null;
  }

  const email = extractEmailFromText(message);
  const phone = extractPhoneFromText(message);

  return {
    id: newActionId(),
    type: "create_contact",
    summary: `Create contact ${contactName} at ${address.addressLine1}, ${address.city}`,
    payload: {
      contactName,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 ?? null,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {})
    },
    ...(note ? { note } : {})
  };
}

function parseAddress(
  raw: string
): { addressLine1: string; addressLine2?: string | null; city: string; state: string; postalCode: string } | null {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;

  const hasLine2 = parts.length >= 4;
  const addressLine1 = parts[0];
  const addressLine2 = hasLine2 ? parts[1] : null;
  const city = hasLine2 ? parts[2] : parts[1];
  const stateZip = hasLine2 ? parts.slice(3).join(" ") : parts.slice(2).join(" ");
  const stateZipParts = stateZip.split(/\s+/).filter(Boolean);
  const state = stateZipParts[0] ?? "";
  const postalCode = stateZipParts.slice(1).join("") || stateZipParts[1] || "";

  if (!addressLine1 || !city || !state || !postalCode) return null;

  return {
    addressLine1,
    addressLine2,
    city,
    state: state.slice(0, 2).toUpperCase(),
    postalCode
  };
}

function extractAddressFromMessage(message: string): string | null {
  const match = message.match(/(\d{3,}[^,]+,\s*[^,]+,\s*[A-Za-z]{2}\s+\d{3,})/);
  if (!match || typeof match[1] !== "string") return null;
  const text = match[1].trim();
  return text.length ? text : null;
}

function extractNameFallback(message: string): string {
  const words = message.replace(/[,@]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]} ${words[1]}`;
  }
  return "New Contact";
}

function extractEmailFromText(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function extractPhoneFromText(text: string): string | null {
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return null;
}

function extractQuoteSuggestion(
  message: string,
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
  },
  note?: string | null,
  servicesHint?: string[] | null
): CreateQuoteAction | null {
  const lower = message.toLowerCase();
  if (
    !lower.includes("quote") &&
    !lower.includes("proposal") &&
    !lower.includes("estimate") &&
    !lower.includes("price") &&
    !lower.includes("bid")
  ) {
    return null;
  }
  if (!ctx.contactId || !ctx.propertyId) return null;

  const services = deriveServicesFromMessage(message, servicesHint);
  const propertyLabel = ctx.property
    ? [ctx.property.addressLine1, ctx.property.city].filter((part) => part && part.length).join(", ")
    : null;

  return {
    id: newActionId(),
    type: "create_quote",
    summary: `Create quote (${services.map(formatServiceLabel).join(", ")})${propertyLabel ? ` at ${propertyLabel}` : ""}`,
    payload: {
      contactId: ctx.contactId,
      propertyId: ctx.propertyId,
      services,
      appointmentId: null,
      notes: note ?? null,
      zoneId: null
    },
    ...(note ? { note } : {})
  };
}

const SERVICE_KEYWORDS: Array<{ id: string; patterns: RegExp[] }> = [
  { id: "single-item", patterns: [/rubbish/i, /trash/i, /garbage/i, /household/i, /single/i, /item/i, /tv/i, /mattress/i] },
  { id: "furniture", patterns: [/furniture/i, /sofa/i, /couch/i, /dresser/i, /bed/i] },
  { id: "appliances", patterns: [/appliance/i, /fridge/i, /washer/i, /dryer/i, /stove/i, /oven/i] },
  { id: "yard-waste", patterns: [/yard/i, /brush/i, /leaves/i, /branches/i] },
  { id: "construction-debris", patterns: [/construction/i, /debris/i, /demo/i, /renovation/i, /junk/i, /load/i] },
  { id: "hot-tub", patterns: [/hot[ -]?tub/i, /spa/i, /jacuzzi/i] },
  { id: "driveway", patterns: [/driveway/i, /concrete/i] },
  { id: "roof", patterns: [/roof/i] },
  { id: "deck", patterns: [/deck/i, /patio/i, /porch/i] },
  { id: "gutter", patterns: [/gutter/i] },
  { id: "commercial", patterns: [/commercial/i, /store/i, /office/i] },
  { id: "other", patterns: [/quote/i, /estimate/i] }
];

function deriveServicesFromMessage(message: string, hints?: string[] | null): string[] {
  const services: string[] = [];
  if (Array.isArray(hints)) {
    for (const hint of hints) {
      if (typeof hint === "string" && hint.trim().length && !services.includes(hint.trim())) {
        services.push(hint.trim());
      }
    }
  }
  for (const entry of SERVICE_KEYWORDS) {
    if (entry.patterns.some((pattern) => pattern.test(message))) {
      if (!services.includes(entry.id)) {
        services.push(entry.id);
      }
    }
  }
  if (!services.length) {
    services.push("other");
  }
  return services.slice(0, 3);
}

function buildBookingActions(
  booking: BookingPayload,
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
  },
  whenHint?: string | null,
  quotedTotalCents?: number | null
): ActionSuggestion[] {
  if (!booking?.suggestions?.length || !booking.contactId || !booking.propertyId) return [];

  const parsed = whenHint ? parseWhen(whenHint) : null;
  const propertyLabel =
    booking.propertyLabel ??
    (ctx.property
      ? [ctx.property.addressLine1, ctx.property.city, ctx.property.state, ctx.property.postalCode]
          .filter((part) => part && part.length)
          .join(", ")
      : null);

  return booking.suggestions.slice(0, 2).map((suggestion) => ({
    id: newActionId(),
    type: "book_appointment" as const,
    summary: `Book ${formatSlotSummary(suggestion.startAt, suggestion.endAt)}${propertyLabel ? ` at ${propertyLabel}` : ""}`,
    payload: {
      contactId: booking.contactId,
      propertyId: booking.propertyId,
      startAt: parsed?.iso ?? suggestion.startAt,
      durationMinutes: 60,
      travelBufferMinutes: 30,
      services: normalizeServiceArray(suggestion.services),
      ...(typeof quotedTotalCents === "number" && Number.isFinite(quotedTotalCents) && quotedTotalCents >= 0
        ? { quotedTotalCents }
        : {})
    },
    context: propertyLabel ? { propertyLabel } : undefined
  }));
}

function formatSlotSummary(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "slot";
  const startLabel = start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const endLabel = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${startLabel} - ${endLabel}`;
}

function normalizeServiceArray(services?: string[] | null): string[] {
  if (Array.isArray(services) && services.length) {
    return services
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)
      .slice(0, 3);
  }
  return ["junk_removal_primary"];
}

function extractActionNote(message: string): string | null {
  const match = message.match(/(?:note|notes|details|message)[:\-]\s*(.+)$/i);
  if (match && typeof match[1] === "string") {
    const text = match[1].trim();
    if (text.length > 0) {
      return text.slice(0, 200);
    }
  }
  return null;
}

function parseWhen(text: string): { iso: string; source: string } | null {
  const lower = text.toLowerCase();
  const now = new Date();

  const dayOffset = lower.includes("tomorrow") ? 1 : 0;
  const base = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);

  // broad windows
  if (lower.includes("morning")) {
    base.setHours(9, 0, 0, 0);
  } else if (lower.includes("afternoon")) {
    base.setHours(13, 0, 0, 0);
  } else if (lower.includes("evening")) {
    base.setHours(17, 0, 0, 0);
  } else {
    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    let hour = 9;
    let minute = 0;
    if (timeMatch) {
      hour = Number(timeMatch[1]);
      minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      const meridiem = timeMatch[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    }
    base.setHours(hour, minute, 0, 0);
  }

  if (base.getTime() < now.getTime()) {
    base.setDate(base.getDate() + 1);
  }

  return { iso: base.toISOString(), source: text };
}

async function extractTaskSuggestion(
  message: string,
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
  },
  note?: string | null
): Promise<CreateTaskAction | null> {
  const lower = message.toLowerCase();
  const hasIntent =
    lower.includes("task") ||
    lower.includes("todo") ||
    lower.includes("to do") ||
    lower.includes("checklist");
  if (!hasIntent) return null;

  if (!ctx.contactId || !ctx.propertyId) return null;

  const appt = await findAppointmentForContext(ctx.contactId, ctx.propertyId);
  if (!appt) return null;

  const title = buildTaskTitle(message, note);

  return {
    id: newActionId(),
    type: "create_task",
    summary: `Add task for appointment${appt.startAt ? ` on ${new Date(appt.startAt).toLocaleString()}` : ""}`,
    payload: {
      appointmentId: appt.id,
      title,
      ...(note ? { note } : {})
    },
    context: {
      appointmentStartAt: appt.startAt ?? null
    }
  };
}

async function findAppointmentForContext(
  contactId?: string,
  propertyId?: string
): Promise<{ id: string; startAt: string | null } | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey || !contactId || !propertyId) return null;

  try {
    const res = await fetch(`${apiBase}/api/appointments?status=confirmed`, {
      headers: { "x-api-key": apiKey }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ id: string; startAt: string | null; contact?: { id: string }; property?: { id: string } }>;
    };
    const matches =
      data.data?.filter(
        (appt) => appt.contact?.id === contactId && appt.property?.id === propertyId
      ) ?? [];
    if (!matches.length) return null;

    const now = Date.now();
    const upcoming = matches
      .filter((appt) => appt.startAt && !Number.isNaN(Date.parse(appt.startAt)) && Date.parse(appt.startAt) >= now)
      .sort((a, b) => Date.parse(a.startAt ?? "") - Date.parse(b.startAt ?? ""));

    const candidate = upcoming[0] ?? matches[0];
    return candidate ?? null;
  } catch (error) {
    console.warn("[chat] appointment_lookup_failed", error);
    return null;
  }
}

function buildTaskTitle(message: string, note?: string | null): string {
  const cleaned = message
    .replace(/\b(add|create|new|make)\b/gi, "")
    .replace(/\b(task|todo|reminder|remind|follow\s*up|follow-up|call\s*back|callback)\b/gi, "")
    .trim();
  const base = cleaned.length >= 4 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Follow up on this job";
  if (note && note.trim().length > 0) {
    return `${base} - ${note.trim()}`;
  }
  return base;
}

function looksLikeExplicitReminderTime(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("tomorrow") || lower.includes("today") || lower.includes("morning") || lower.includes("afternoon") || lower.includes("evening")) {
    return true;
  }
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(message)) return true;
  return false;
}

function extractReminderSuggestion(
  message: string,
  ctx: { contactId?: string },
  note?: string | null
): CreateReminderAction | null {
  if (!ctx.contactId) return null;
  const lower = message.toLowerCase();
  const hasIntent =
    lower.includes("remind") ||
    lower.includes("reminder") ||
    lower.includes("follow up") ||
    lower.includes("follow-up") ||
    lower.includes("call back") ||
    lower.includes("call-back") ||
    lower.includes("callback");
  if (!hasIntent) return null;
  if (!looksLikeExplicitReminderTime(message)) return null;

  const when = parseWhen(message);
  if (!when) return null;

  const title =
    lower.includes("call") ? "Call back" : lower.includes("text") || lower.includes("sms") ? "Text follow-up" : "Follow up";

  return {
    id: newActionId(),
    type: "create_reminder",
    summary: `Create reminder (${title})`,
    payload: {
      contactId: ctx.contactId,
      title,
      dueAt: when.iso,
      ...(note && note.trim().length ? { notes: note.trim() } : {})
    }
  };
}

function extractContactNoteSuggestion(
  message: string,
  ctx: { contactId?: string },
  note?: string | null
): AddContactNoteAction | null {
  if (!ctx.contactId) return null;
  const lower = message.toLowerCase();
  const hasIntent =
    lower.includes("add note") ||
    lower.includes("log note") ||
    lower.includes("save note") ||
    lower.includes("note:") ||
    lower.startsWith("note ");
  if (!hasIntent) return null;

  const fallbackMatch = message.match(/(?:note|notes)\s*[:\-]\s*(.+)$/i);
  const body = (note ?? fallbackMatch?.[1] ?? "").trim();
  if (!body.length) return null;

  return {
    id: newActionId(),
    type: "add_contact_note",
    summary: "Add note to contact",
    payload: {
      contactId: ctx.contactId,
      body
    }
  };
}

async function classifyIntent(message: string): Promise<IntentClassification | null> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = (process.env["OPENAI_MODEL"] ?? DEFAULT_BRAIN_MODEL).trim() || DEFAULT_BRAIN_MODEL;
  if (!apiKey) return null;

  const systemPrompt = `
You classify a chat message into intents: booking, contact, quote, task, or none.
Return ONLY JSON with keys: intent, contactName, address, services (array), note.
Keep note short (<120 chars). If unsure, use intent "none".
`.trim();

  const payload = {
    model,
    input: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message }
    ],
    reasoning: { effort: "low" as const },
    text: {
      verbosity: "low" as const,
      format: {
        type: "json_schema" as const,
        name: "intent_classification",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: {
              type: "string",
              enum: ["booking", "contact", "quote", "task", "none"]
            },
            contactName: { type: "string" },
            address: { type: "string" },
            services: { type: "array", items: { type: "string" } },
            note: { type: "string" },
            when: { type: "string" }
          },
          required: ["intent"]
        }
      }
    },
    max_output_tokens: 180,
  };

  try {
    const res = await fetchOpenAIText(apiKey, payload, model);
    if (!res.ok) {
      console.warn("[chat] intent classify failed", res.status, res.error.slice(0, 120));
      return null;
    }
    const parsed = safeJsonParse(res.text);
    if (parsed && typeof parsed["intent"] === "string") {
      const intent = ["booking", "contact", "quote", "task"].includes(parsed["intent"])
        ? (parsed["intent"] as IntentClassification["intent"])
        : "none";
      return {
        intent,
        contactName: typeof parsed["contactName"] === "string" ? parsed["contactName"] : undefined,
        address: typeof parsed["address"] === "string" ? parsed["address"] : undefined,
        services: Array.isArray(parsed["services"])
          ? parsed["services"].filter((s: unknown) => typeof s === "string" && s.trim().length)
          : undefined,
        note: typeof parsed["note"] === "string" ? parsed["note"] : undefined,
        when: typeof parsed["when"] === "string" ? parsed["when"] : undefined
      };
    }
  } catch (error) {
    console.warn("[chat] intent classify error", error);
  }
  return null;
}

function safeJsonParse(text: string): Record<string, any> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function newActionId(): string {
  // Guard against environments without crypto.randomUUID (mainly for tests)
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}
