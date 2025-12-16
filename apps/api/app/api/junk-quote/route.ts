import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, instantQuotes } from "@/db";

const DISCOUNT = Number(process.env["INSTANT_QUOTE_DISCOUNT"] ?? 0);
const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/u, "")).filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(response: NextResponse, requestOrigin: string | null): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, requestOrigin: string | null, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }), request.headers.get("origin"));
}

const RequestSchema = z.object({
  source: z.string().optional().default("public_site"),
  contact: z.object({
    name: z.string().min(2),
    phone: z.string().min(7),
    timeframe: z.enum(["today", "tomorrow", "this_week", "flexible"])
  }),
  job: z.object({
    types: z
      .array(
        z.enum([
          "furniture",
          "appliances",
          "general_junk",
          "yard_waste",
          "construction_debris",
          "hot_tub_playset",
          "business_commercial"
        ])
      )
      .min(0),
    perceivedSize: z.enum(["few_items", "small_area", "one_room_or_half_garage", "big_cleanout", "not_sure"]),
    notes: z.string().optional().nullable(),
    zip: z.string().min(3),
    photoUrls: z.array(z.string().url()).max(4).default([])
  })
});

const QuoteResultSchema = z.object({
  loadFractionEstimate: z.number(),
  priceLow: z.number(),
  priceHigh: z.number(),
  displayTierLabel: z.string(),
  reasonSummary: z.string(),
  needsInPersonEstimate: z.boolean()
});

const VOLUME_PRICING = {
  quarter: 200,
  half: 400,
  threeQuarter: 600,
  full: 800
} as const;

function getVolumeQuote(perceivedSize: z.infer<typeof RequestSchema>["job"]["perceivedSize"]) {
  const p = VOLUME_PRICING;
  switch (perceivedSize) {
    case "few_items":
      return {
        loadFractionEstimate: 0.25,
        priceLow: p.quarter,
        priceHigh: p.quarter,
        displayTierLabel: "1/4 trailer",
        reasonSummary: "Based on your selected size, this looks like about a quarter-trailer load.",
        needsInPersonEstimate: false
      };
    case "small_area":
      return {
        loadFractionEstimate: 0.375,
        priceLow: p.quarter,
        priceHigh: p.half,
        displayTierLabel: "1/4 to 1/2 trailer",
        reasonSummary: "Based on your selected size, this looks like a small load between a quarter and half trailer.",
        needsInPersonEstimate: false
      };
    case "one_room_or_half_garage":
      return {
        loadFractionEstimate: 0.625,
        priceLow: p.half,
        priceHigh: p.threeQuarter,
        displayTierLabel: "Half to 3/4 trailer",
        reasonSummary: "Based on your selected size, this looks like about a half to three-quarters trailer load.",
        needsInPersonEstimate: false
      };
    case "big_cleanout":
      return {
        loadFractionEstimate: 0.875,
        priceLow: p.threeQuarter,
        priceHigh: p.full,
        displayTierLabel: "3/4 to full trailer",
        reasonSummary: "Based on your selected size, this looks like a large load between three-quarters and a full trailer.",
        needsInPersonEstimate: false
      };
    case "not_sure":
    default:
      return {
        loadFractionEstimate: 0.65,
        priceLow: p.half,
        priceHigh: p.full,
        displayTierLabel: "Half to full trailer",
        reasonSummary: "Since you're not sure on size yet, we're quoting a broad half-to-full trailer range.",
        needsInPersonEstimate: true
      };
  }
}

export async function POST(request: NextRequest) {
  try {
    const requestOrigin = request.headers.get("origin");
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, { status: 400 });
    }
    const body = parsed.data;

    const base = getVolumeQuote(body.job.perceivedSize);
    const validatedBase = QuoteResultSchema.safeParse(base);
    if (!validatedBase.success) {
      console.error("[junk-quote] volume_quote_invalid", validatedBase.error.flatten());
      return corsJson({ error: "server_error" }, requestOrigin, { status: 500 });
    }

    const discount = DISCOUNT > 0 && DISCOUNT < 1 ? DISCOUNT : 0;
    const priceLowDiscounted = Math.round(validatedBase.data.priceLow * (1 - discount));
    const priceHighDiscounted = Math.round(validatedBase.data.priceHigh * (1 - discount));

    const db = getDb();
    const [quoteRow] = await db
      .insert(instantQuotes)
      .values({
        source: body.source ?? "public_site",
        contactName: body.contact.name.trim(),
        contactPhone: body.contact.phone.trim(),
        timeframe: body.contact.timeframe,
        zip: body.job.zip.trim(),
        jobTypes: body.job.types,
        perceivedSize: body.job.perceivedSize,
        notes: body.job.notes ?? null,
        photoUrls: body.job.photoUrls ?? [],
        aiResult: {
          ...validatedBase.data,
          discountPercent: discount,
          priceLowDiscounted,
          priceHighDiscounted
        }
      })
      .returning({ id: instantQuotes.id });

    return corsJson({
      ok: true,
      quoteId: quoteRow?.id ?? null,
      quote: {
        ...validatedBase.data,
        discountPercent: discount,
        priceLowDiscounted,
        priceHighDiscounted
      }
    }, requestOrigin);
  } catch (error) {
    console.error("[junk-quote] server_error", error);
    return corsJson({ error: "server_error" }, null, { status: 500 });
  }
}

async function getQuoteFromAi(body: z.infer<typeof RequestSchema>) {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
  if (!apiKey) {
    throw new Error("missing_api_key");
  }

  type TextFormat = "json_schema" | "json_object";

  const jsonSchemaFormat = {
    type: "json_schema",
    name: "junk_quote",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        loadFractionEstimate: { type: "number" },
        priceLow: { type: "number" },
        priceHigh: { type: "number" },
        displayTierLabel: { type: "string" },
        reasonSummary: { type: "string" },
        needsInPersonEstimate: { type: "boolean" }
      },
      required: [
        "loadFractionEstimate",
        "priceLow",
        "priceHigh",
        "displayTierLabel",
        "reasonSummary",
        "needsInPersonEstimate"
      ]
    }
  } as const;

  async function requestOpenAi(format: TextFormat) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input: JSON.stringify(body.job),
        tools: [],
        tool_choice: "none",
        reasoning: {
          effort: "minimal"
        },
        text: {
          format: format === "json_schema" ? jsonSchemaFormat : { type: "json_object" }
        },
        max_output_tokens: 1200
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ai_failed_${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      error?: { code?: string | null; message?: string } | null;
      incomplete_details?: { reason?: string } | null;
      usage?: unknown;
      output?: unknown;
    };

    const responseId = typeof data.id === "string" ? data.id : "unknown";
    const status = typeof data.status === "string" ? data.status : "unknown";
    const incompleteReason =
      typeof data.incomplete_details?.reason === "string" ? data.incomplete_details.reason : "unknown";
    const code = typeof data.error?.code === "string" ? data.error.code : "unknown";
    const message = typeof data.error?.message === "string" ? data.error.message : "no_message";

    const outputItems = Array.isArray(data.output) ? data.output : [];
    const outputTextParts: string[] = [];
    const refusalParts: string[] = [];
    const anyTextParts: string[] = [];

    const getText = (value: unknown): string | null => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record["value"] === "string") return record["value"];
      }
      return null;
    };

    const pushText = (text: string | null) => {
      if (!text) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      anyTextParts.push(trimmed);
    };

    for (const item of outputItems) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;

      const content = record["content"];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const typed = part as Record<string, unknown>;
          const partType = typeof typed["type"] === "string" ? typed["type"] : "";

          const text = getText(typed["text"]);
          if (partType === "output_text" && text) {
            outputTextParts.push(text);
          }
          if (partType === "refusal" && typeof typed["refusal"] === "string") {
            refusalParts.push(typed["refusal"]);
          }
          pushText(text);
        }
      }

      const summary = record["summary"];
      if (Array.isArray(summary)) {
        for (const part of summary) {
          if (!part || typeof part !== "object") continue;
          const typed = part as Record<string, unknown>;
          pushText(getText(typed["text"]));
        }
      }
    }

    const raw = outputTextParts.join("\n").trim() || anyTextParts.join("\n").trim();
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          return JSON.parse(raw.slice(start, end + 1));
        }
        throw new Error("ai_invalid_json_output");
      }
    }

    const logDebug = (label: string) => {
      try {
        const outputSummary = outputItems.slice(0, 3).map((item) => {
          if (!item || typeof item !== "object") return { kind: typeof item };
          const record = item as Record<string, unknown>;
          const itemType = typeof record["type"] === "string" ? record["type"] : "unknown";
          const itemStatus = typeof record["status"] === "string" ? record["status"] : undefined;
          const content = record["content"];
          const summary = record["summary"];
          return {
            type: itemType,
            status: itemStatus,
            keys: Object.keys(record).slice(0, 12),
            contentTypes: Array.isArray(content)
              ? content
                  .slice(0, 5)
                  .map((part) =>
                    part && typeof part === "object" ? (part as Record<string, unknown>)["type"] : typeof part
                  )
              : undefined,
            summaryTypes: Array.isArray(summary)
              ? summary
                  .slice(0, 5)
                  .map((part) =>
                    part && typeof part === "object" ? (part as Record<string, unknown>)["type"] : typeof part
                  )
              : undefined
          };
        });
        console.error(label, {
          responseId,
          status,
          incomplete_details: data.incomplete_details,
          error: data.error,
          usage: data.usage,
          outputLen: outputItems.length,
          outputSummary
        });
      } catch {}
    };

    if (status !== "completed") {
      logDebug("[junk-quote] ai_noncompleted_debug");
      const suffix = status === "incomplete" ? `_${incompleteReason}` : `_${code}`;
      throw new Error(`ai_${status}${suffix}: ${message}`.slice(0, 220));
    }

    if (refusalParts.length) {
      throw new Error(`ai_refusal: ${refusalParts.join(" ").slice(0, 200)}`);
    }

    logDebug("[junk-quote] ai_empty_output_debug");
    throw new Error("ai_empty_output_text");
  }

  try {
    return await requestOpenAi("json_schema");
  } catch (error) {
    if (error instanceof Error && error.message === "missing_api_key") {
      throw error;
    }
    console.error("[junk-quote] ai_retrying_with_json_object", error instanceof Error ? error.message : error);
    return await requestOpenAi("json_object");
  }
}

const SYSTEM_PROMPT = `
You are the quoting assistant for Stonegate Junk Removal in Woodstock, Georgia.
Stonegate uses one large 7x16x4 dump trailer. Pricing anchors:
- 1/4 trailer: $200
- 1/2 trailer: $400
- 3/4 trailer: $600
- Full trailer: $800

Rules:
- Respond ONLY with JSON: { "loadFractionEstimate": number, "priceLow": number, "priceHigh": number, "displayTierLabel": string, "reasonSummary": string, "needsInPersonEstimate": boolean }
- Always give a price range, never a single number.
- Map perceived size to trailer fraction:
  few_items -> ~0.25
  small_area -> 0.25-0.5
  one_room_or_half_garage -> 0.5-0.75
  big_cleanout -> 0.75-1.0+
  not_sure -> err on 0.5+ unless clearly tiny
- Use the pricing anchors to set ranges (never below $150). Adjust up for dense/heavy or large/commercial jobs.
- If job seems more than one trailer or complex, set needsInPersonEstimate=true.
- displayTierLabel: short category like "Small load", "Half trailer", "Large to full trailer", "Multi-trailer project".
- reasonSummary: one friendly sentence.
`.trim();
