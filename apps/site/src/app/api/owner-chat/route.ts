import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";

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

type PaymentDto = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  cardBrand: string | null;
  last4: string | null;
  createdAt: string;
};

type ChatRequest = {
  message?: string;
};

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

function pickRange(message: string): "today" | "tomorrow" | "this_week" | "next_week" {
  const lower = message.toLowerCase();
  if (lower.includes("tomorrow")) return "tomorrow";
  if (lower.includes("today")) return "today";
  if (lower.includes("next week")) return "next_week";
  return "this_week";
}

function fmtMoney(cents: number, currency: string | null): string {
  if (!Number.isFinite(cents)) return "$0";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { message } = (await request.json()) as ChatRequest;
    const trimmedMessage = message?.trim() ?? "";
    if (!trimmedMessage) {
      return NextResponse.json({ error: "missing_message" }, { status: 400 });
    }

    const apiKey = process.env["OPENAI_API_KEY"];
    const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
    const range = pickRange(trimmedMessage);

    const [schedule, revenue, payments] = await Promise.all([
      fetchSchedule(range),
      fetchRevenue(range),
      fetchRecentPayments()
    ]);

    const scheduleText = schedule ?? `Schedule ${range}: unavailable or no appointments.`;
    const revenueText = revenue ?? `Revenue ${range}: unavailable or no payments.`;
    const paymentsText =
      payments && payments.length
        ? `Recent payments:\n${payments
            .slice(0, 5)
            .map(
              (p) =>
                `- ${fmtMoney(p.amount, p.currency)} (${p.status}) ${p.cardBrand ?? p.method ?? "payment"} on ${new Date(
                  p.createdAt
                ).toLocaleDateString()}`
            )
            .join("\n")}`
        : "Recent payments: none yet.";

    if (!apiKey) {
      const fallback = `${scheduleText}\n\n${revenueText}\n\n${paymentsText}`;
      return NextResponse.json({ reply: fallback });
    }

    const systemPrompt = `
You are the Owner Assist bot for Stonegate. Use the provided data only.

Schedule:
${scheduleText}

Revenue:
${revenueText}

Payments:
${paymentsText}

Guidelines:
- Answer concisely (1-3 sentences).
- If data is missing, say so briefly.
- Do not invent numbers. Use only the data above.
    `.trim();

    const payload = {
      model,
      input: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: trimmedMessage }
      ],
      reasoning: { effort: "low" as const },
      text: { verbosity: "medium" as const },
      max_output_tokens: 400
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
      console.error(`[owner-chat] OpenAI error for model '${model}' status ${response.status}: ${body.slice(0, 300)}`);
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

    const reply =
      data.output_text?.trim() ??
      data.output
        ?.flatMap((item) => item?.content ?? [])
        ?.map((chunk) => chunk?.text ?? "")
        ?.filter((chunk) => typeof chunk === "string" && chunk.trim().length > 0)
        ?.join("\n")
        ?.trim() ??
      "";

    const finalReply = reply.length ? reply : `${scheduleText}\n\n${revenueText}\n\n${paymentsText}`;
    return NextResponse.json({ ok: true, reply: finalReply });
  } catch (error) {
    console.error("[owner-chat] Server error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

async function fetchSchedule(range: string): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const res = await fetch(`${apiBase}/api/admin/schedule/summary?range=${encodeURIComponent(range)}`, {
      headers: { "x-api-key": apiKey }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ScheduleSummary;
    if (!data.ok) return null;
    const label = rangeLabel(range);
    if (!data.total) return `Schedule ${label}: no appointments.`;
    const statusParts = Object.entries(data.byStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const byDay = data.byDay
      .slice(0, 3)
      .map((d) => `${d.date}: ${d.count}`)
      .join(", ");
    return `Schedule ${label}: ${data.total} appt(s)${statusParts ? ` (${statusParts})` : ""}${byDay ? `. Busiest: ${byDay}` : ""}`;
  } catch (error) {
    console.warn("[owner-chat] schedule_summary_failed", error);
    return null;
  }
}

async function fetchRevenue(range: string): Promise<string | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;

  try {
    const res = await fetch(`${apiBase}/api/admin/revenue/forecast?range=${encodeURIComponent(range)}`, {
      headers: { "x-api-key": apiKey }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RevenueForecast;
    if (!data.ok) return null;
    const label = rangeLabel(range);
    return `Revenue ${label}: ${fmtMoney(data.totalCents, data.currency)} across ${data.count} payment(s).`;
  } catch (error) {
    console.warn("[owner-chat] revenue_forecast_failed", error);
    return null;
  }
}

async function fetchRecentPayments(): Promise<PaymentDto[] | null> {
  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) return null;
  try {
    const res = await fetch(`${apiBase}/api/payments?status=all&limit=10`, {
      headers: { "x-api-key": apiKey }
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { payments?: PaymentDto[] };
    return (data.payments ?? []).slice(0, 10);
  } catch (error) {
    console.warn("[owner-chat] payments_fetch_failed", error);
    return null;
  }
}

function rangeLabel(range: string): string {
  if (range === "today") return "today";
  if (range === "tomorrow") return "tomorrow";
  if (range === "next_week") return "next week";
  return "this week";
}
