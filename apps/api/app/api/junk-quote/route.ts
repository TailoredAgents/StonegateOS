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

const AiResponseSchema = z.object({
  loadFractionEstimate: z.number(),
  priceLow: z.number(),
  priceHigh: z.number(),
  displayTierLabel: z.string(),
  reasonSummary: z.string(),
  needsInPersonEstimate: z.boolean()
});

const FALLBACK_AI = {
  loadFractionEstimate: 0.5,
  priceLow: 350,
  priceHigh: 800,
  displayTierLabel: "Estimate unavailable",
  reasonSummary: "AI quote service failed; fallback range used.",
  needsInPersonEstimate: true
};

export async function POST(request: NextRequest) {
  try {
    const requestOrigin = request.headers.get("origin");
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, { status: 400 });
    }
    const body = parsed.data;

    const aiResult = await getQuoteFromAi(body).catch((err) => {
      console.error("[junk-quote] ai_failed", err instanceof Error ? err.message : err);
      return FALLBACK_AI;
    });
    const aiValidated = AiResponseSchema.safeParse(aiResult);
    const base = aiValidated.success ? aiValidated.data : FALLBACK_AI;
    if (!aiValidated.success) {
      console.error("[junk-quote] ai_invalid_response", aiResult);
    }

    const discount = DISCOUNT > 0 && DISCOUNT < 1 ? DISCOUNT : 0;
    const priceLowDiscounted = Math.round(base.priceLow * (1 - discount));
    const priceHighDiscounted = Math.round(base.priceHigh * (1 - discount));

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
          ...base,
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
        ...base,
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

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(body.job) }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
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
        }
      },
      max_output_tokens: 400,
      temperature: 0.3
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ai_failed_${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as { output_text?: string };
  const raw = typeof data.output_text === "string" && data.output_text.trim().length ? data.output_text : "{}";
  return JSON.parse(raw);
}

const SYSTEM_PROMPT = `
You are the quoting assistant for Stonegate Junk Removal in Woodstock, Georgia.
Stonegate uses one large 7×16×4 dump trailer. Pricing anchors:
- 1/4 trailer: $200
- 1/2 trailer: $400
- 3/4 trailer: $600
- Full trailer: $800

Rules:
- Respond ONLY with JSON: { "loadFractionEstimate": number, "priceLow": number, "priceHigh": number, "displayTierLabel": string, "reasonSummary": string, "needsInPersonEstimate": boolean }
- Always give a price range, never a single number.
- Map perceived size to trailer fraction:
  few_items -> ~0.25
  small_area -> 0.25–0.5
  one_room_or_half_garage -> 0.5–0.75
  big_cleanout -> 0.75–1.0+
  not_sure -> err on 0.5+ unless clearly tiny
- Use the pricing anchors to set ranges (never below $150). Adjust up for dense/heavy or large/commercial jobs.
- If job seems more than one trailer or complex, set needsInPersonEstimate=true.
- displayTierLabel: short category like "Small load", "Half trailer", "Large to full trailer", "Multi-trailer project".
- reasonSummary: one friendly sentence.
`.trim();
