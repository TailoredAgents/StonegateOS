import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";

const SYSTEM_PROMPT = `You are Stonegate Assist, the warm front-office voice for Stonegate Junk Removal in North Metro Atlanta. Think like a friendly teammate, not a call script.

Principles:
- Keep replies to 1-2 sentences and under ~45 words. Sound natural, confident, and approachable.
- Reference only the services or details that fit the question. Typical offerings include: furniture removal, mattress disposal, appliance hauling, garage/attic cleanouts, yard waste, and light construction debris (no hazardous waste).
- Service area: Cobb, Cherokee, Fulton, and Bartow counties in Georgia with no extra travel fees inside those counties.
- Pricing: speak in ranges only (single items $75-$125, quarter load $150-$250, half load $280-$420, full load $480-$780). Never promise an exact total.
- Process notes (use when relevant): licensed and insured two-person crews, careful in-home handling, responsible disposal and recycling when possible.
- Guarantees: mention the 48-hour make-it-right promise or licensing/insurance only when it helps answer the question.
- Scheduling: if the user hints at booking and a contact/property is provided, offer a short confirmation and suggested slots. Otherwise, mention the "Schedule Estimate" button (#schedule-estimate) or call (404) 692-0768 only when the user asks about booking, timing, or next steps.
- Preparation tips (share only if asked): separate items for pickup, ensure clear pathways, and note stairs or heavy items.
- Escalate politely to a human if the request is hazardous, urgent, or needs a firm commitment.
- Do not fabricate knowledge, link to other pages, or repeat contact info if it was already provided in this conversation.

Stay personable, concise, and helpful.`;

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
  };
  context?: {
    propertyLabel?: string;
  };
};

type ActionSuggestion = (CreateContactAction | CreateQuoteAction | CreateTaskAction | CreateBookingAction) & {
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

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

export async function POST(request: NextRequest) {
  try {
    const { message, contactId, propertyId, property, mode } = (await request.json()) as ChatRequest;
    const audience = mode === "team" ? "team" : "public";
    const isTeamChat = audience === "team";
    const trimmedMessage = message?.trim() ?? "";
    if (!trimmedMessage) {
      return NextResponse.json({ error: "missing_message" }, { status: 400 });
    }

    const apiKey = process.env["OPENAI_API_KEY"];
    const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "openai_not_configured",
          message: "OpenAI API key not configured on the server"
        },
        { status: 503 }
      );
    }

    const payload = {
      model,
      input: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: trimmedMessage }
      ],
      reasoning: { effort: "low" as const },
      text: { verbosity: "medium" as const },
      max_output_tokens: 500
    };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[chat] OpenAI error for model '${model}' status ${response.status}: ${body.slice(0, 300)}`);
      return NextResponse.json(
        {
          error: "openai_error",
          message: "Assistant is unavailable right now."
        },
        { status: 502 }
      );
    }

    const data = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
      output_text?: string;
    };

    let reply =
      data.output_text?.trim() ??
      data.output
        ?.flatMap((item) => item?.content ?? [])
        ?.map((chunk) => chunk?.text ?? "")
        ?.filter((chunk) => typeof chunk === "string" && chunk.trim().length > 0)
        ?.join("\n")
        ?.trim() ??
      "";

    if (!reply) {
      console.error("[chat] OpenAI returned empty output for site chatbot.");
      return NextResponse.json(
        {
          error: "openai_empty",
          message: "Assistant did not return a response."
        },
        { status: 502 }
      );
    }

    const booking = await maybeGetSuggestions(trimmedMessage, {
      contactId,
      propertyId,
      property
    });
    const classification = isTeamChat ? await classifyIntent(trimmedMessage) : null;
    const wantsSchedule = looksLikeScheduleQuestion(trimmedMessage);
    const wantsRevenue = looksLikeRevenueQuestion(trimmedMessage);
    const range = wantsSchedule || wantsRevenue ? pickRange(trimmedMessage) : "this_week";

    const [scheduleText, revenueText] = await Promise.all([
      wantsSchedule ? fetchScheduleSummary(range) : Promise.resolve(null),
      wantsRevenue ? fetchRevenueForecast(range) : Promise.resolve(null)
    ]);

    const actions = isTeamChat
      ? await buildActionSuggestions(
          trimmedMessage,
          {
            contactId,
            propertyId,
            property
          },
          booking,
          classification
        )
      : [];
    const actionNote =
      isTeamChat && actions.length
        ? actions.map((action) => `Action: ${action.summary}`).join("\n")
        : null;

    const replyParts = [reply];

    if (booking && booking.suggestions.length) {
      replyParts.push(
        `Suggested slots:\n${booking.suggestions
          .map(
            (s) =>
              `- ${new Date(s.startAt).toLocaleString()} - ${new Date(s.endAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${s.reason})`
          )
          .join("\n")}`
      );
    }

    if (scheduleText) {
      replyParts.push(scheduleText);
    }

    if (revenueText) {
      replyParts.push(revenueText);
    }

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

  const suggestions = await fetchBookingSuggestions(ctx);
  if (!suggestions || !suggestions.length) return null;
  return {
    contactId: ctx.contactId,
    propertyId: ctx.propertyId,
    suggestions,
    propertyLabel: ctx.propertyLabel
  };
}

async function fetchBookingSuggestions(
  ctx: {
    contactId?: string;
    propertyId?: string;
    property?: { addressLine1?: string; city?: string; state?: string; postalCode?: string };
  }
): Promise<BookingSuggestion[] | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const body: {
      durationMinutes: number;
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

async function fetchScheduleSummary(range: string): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const res = await fetch(`${apiBase}/api/admin/schedule/summary?range=${encodeURIComponent(range)}`, {
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
  classification?: IntentClassification | null
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

  if (booking) {
    const bookingActions = buildBookingActions(booking, ctx, when);
    actions.push(
      ...bookingActions.map((action) => ({
        ...action,
        ...(note ? { note } : {})
      }))
    );
  }

  return actions.slice(0, 3);
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
    summary: `Create quote (${services.join(", ")})${propertyLabel ? ` at ${propertyLabel}` : ""}`,
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
  { id: "single-item", patterns: [/single/i, /item/i, /tv/i, /mattress/i] },
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
  whenHint?: string | null
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
      services: normalizeServiceArray(suggestion.services)
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
    lower.includes("remind") ||
    lower.includes("follow up") ||
    lower.includes("follow-up") ||
    lower.includes("call back") ||
    lower.includes("call-back");
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

async function findAppointmentForContext(contactId?: string, propertyId?: string): Promise<{
  id: string;
  startAt: string | null;
}> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey || !contactId || !propertyId) return null;

  try {
    const res = await fetch(`${apiBase}/api/appointments?status=confirmed,requested`, {
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

    return upcoming[0] ?? matches[0];
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
    return `${base} — ${note.trim()}`;
  }
  return base;
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

async function classifyIntent(message: string): Promise<IntentClassification | null> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
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
    text: { verbosity: "low" as const },
    max_output_tokens: 180,
    response_format: { type: "json_object" as const }
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[chat] intent classify failed", res.status, text.slice(0, 120));
      return null;
    }
    const data = (await res.json()) as { output_text?: string };
    const raw = data.output_text ?? "";
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed.intent === "string") {
      return {
        intent: ["booking", "contact", "quote", "task"].includes(parsed.intent) ? parsed.intent : "none",
        contactName: typeof parsed.contactName === "string" ? parsed.contactName : undefined,
        address: typeof parsed.address === "string" ? parsed.address : undefined,
        services: Array.isArray(parsed.services)
          ? parsed.services.filter((s: unknown) => typeof s === "string" && s.trim().length)
          : undefined,
        note: typeof parsed.note === "string" ? parsed.note : undefined
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
