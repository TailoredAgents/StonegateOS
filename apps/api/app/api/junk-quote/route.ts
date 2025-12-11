import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, instantQuotes } from "@/db";
import { callOpenAI } from "@/lib/ai";

const DISCOUNT = Number(process.env["INSTANT_QUOTE_DISCOUNT"] ?? 0);

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
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    const aiResult = await getQuoteFromAi(body).catch(() => FALLBACK_AI);
    const aiValidated = AiResponseSchema.safeParse(aiResult);
    const base = aiValidated.success ? aiValidated.data : FALLBACK_AI;

    const discount = DISCOUNT > 0 && DISCOUNT < 1 ? DISCOUNT : 0;
    const priceLowDiscounted = Math.round(base.priceLow * (1 - discount));
    const priceHighDiscounted = Math.round(base.priceHigh * (1 - discount));

    const db = getDb();
    await db.insert(instantQuotes).values({
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
    });

    return NextResponse.json({
      ok: true,
      quote: {
        ...base,
        discountPercent: discount,
        priceLowDiscounted,
        priceHighDiscounted
      }
    });
  } catch (error) {
    console.error("[junk-quote] server_error", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

async function getQuoteFromAi(body: z.infer<typeof RequestSchema>) {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
  if (!apiKey) {
    throw new Error("missing_api_key");
  }

  const response = await callOpenAI({
    apiKey,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(body.job),
    responseFormat: {
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
    },
    maxTokens: 400
  });

  if (!response) {
    throw new Error("ai_failed");
  }

  const raw =
    typeof response === "string"
      ? response
      : (response as any).output_text ??
        (response as any).output ??
        (Array.isArray((response as any).output) ? (response as any).output.join("") : "{}");

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
