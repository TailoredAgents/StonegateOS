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
- Scheduling: mention the "Schedule Estimate" button (#schedule-estimate) or call (404) 445-3408 only when the user asks about booking, timing, or next steps; otherwise skip the CTA.
- Preparation tips (share only if asked): separate items for pickup, ensure clear pathways, and note stairs or heavy items.
- Escalate politely to a human if the request is hazardous, urgent, or needs a firm commitment.
- Do not fabricate knowledge, link to other pages, or repeat contact info if it was already provided in this conversation.

Stay personable, concise, and helpful.`;

type Suggestion = { start: string; end: string; reason: string };

export async function POST(request: NextRequest) {
  try {
    const { message } = (await request.json()) as { message?: string };
    if (!message || message.trim().length === 0) {
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
        { role: "user" as const, content: message }
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

    const suggestions = await maybeGetSuggestions(message);
    const finalReply =
      suggestions && suggestions.length
        ? `${reply}\n\nSuggested slots:\n${suggestions.map((s) => `- ${s.start} – ${s.end} (${s.reason})`).join("\n")}`
        : reply;

    return NextResponse.json({ ok: true, reply: finalReply });
  } catch (error) {
    console.error("[chat] Server error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

async function maybeGetSuggestions(message: string): Promise<Suggestion[] | null> {
  const keywords = ["book", "schedule", "slot", "time", "appointment"];
  const lower = message.toLowerCase();
  if (!keywords.some((kw) => lower.includes(kw))) return null;

  return (await fetchBookingSuggestions()) ?? null;
}

async function fetchBookingSuggestions(): Promise<Suggestion[] | null> {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const hdrs = await headers();
  const adminKey = process.env["ADMIN_API_KEY"] ?? hdrs.get("x-api-key");
  if (!adminKey) return null;

  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/admin/booking/assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": adminKey
      },
      body: JSON.stringify({})
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { suggestions?: Array<{ startAt?: string; endAt?: string; reason?: string }> };
    const suggestions =
      data.suggestions
        ?.slice(0, 3)
        .map((s) => ({
          start: s.startAt ? new Date(s.startAt).toLocaleString() : "TBD",
          end: s.endAt ? new Date(s.endAt).toLocaleString() : "TBD",
          reason: s.reason ?? "No conflicts"
        })) ?? [];
    return suggestions;
  } catch (error) {
    console.warn("[chat] suggestion_fetch_failed", { error: String(error) });
    return null;
  }
}
