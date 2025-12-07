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
- Scheduling: if the user hints at booking and a contact/property is provided, offer a short confirmation and suggested slots. Otherwise, mention the "Schedule Estimate" button (#schedule-estimate) or call (404) 445-3408 only when the user asks about booking, timing, or next steps.
- Preparation tips (share only if asked): separate items for pickup, ensure clear pathways, and note stairs or heavy items.
- Escalate politely to a human if the request is hazardous, urgent, or needs a firm commitment.
- Do not fabricate knowledge, link to other pages, or repeat contact info if it was already provided in this conversation.

Stay personable, concise, and helpful.`;

type BookingSuggestion = { startAt: string; endAt: string; reason: string };

type BookingPayload = {
  contactId: string;
  propertyId: string;
  suggestions: BookingSuggestion[];
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
    const { message, contactId, propertyId, property } = (await request.json()) as ChatRequest;
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
    const wantsSchedule = looksLikeScheduleQuestion(trimmedMessage);
    const wantsRevenue = looksLikeRevenueQuestion(trimmedMessage);
    const range = wantsSchedule || wantsRevenue ? pickRange(trimmedMessage) : "this_week";

    const [scheduleText, revenueText] = await Promise.all([
      wantsSchedule ? fetchScheduleSummary(range) : Promise.resolve(null),
      wantsRevenue ? fetchRevenueForecast(range) : Promise.resolve(null)
    ]);

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
      ...(booking ? { booking } : {})
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
    suggestions
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
