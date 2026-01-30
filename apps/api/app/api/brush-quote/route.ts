import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, crmPipeline, instantQuotes, leads, outboxEvents, properties } from "@/db";
import { getCompanyProfilePolicy, isGeorgiaPostalCode, normalizePostalCode } from "@/lib/policy";
import { desc, eq } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../web/persistence";
import { normalizeName, normalizePhone } from "../web/utils";

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

async function resolveInstantQuoteDiscountPercent(db: ReturnType<typeof getDb>): Promise<number> {
  const envRaw = process.env["INSTANT_QUOTE_DISCOUNT"];
  const envValue = envRaw ? Number(envRaw) : NaN;
  if (Number.isFinite(envValue) && envValue > 0 && envValue < 1) {
    return envValue;
  }

  const profile = await getCompanyProfilePolicy(db);
  const percent = profile.discountPercent;
  if (!Number.isFinite(percent)) return 0;
  if (percent <= 0 || percent >= 1) return 0;
  return percent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const BrushPrimarySchema = z.enum([
  "light_brush",
  "overgrowth",
  "weeds_vines",
  "small_saplings",
  "downed_branches",
  "storm_debris",
  "other"
]);

const BrushDifficultySchema = z.enum(["easy", "moderate", "hard", "not_sure"]);

const RequestSchema = z.object({
  source: z.string().optional().default("public_site"),
  contact: z.object({
    name: z.string().min(2),
    phone: z.string().min(7),
    timeframe: z.enum(["today", "tomorrow", "this_week", "flexible"]).optional().default("flexible")
  }),
  job: z.object({
    primary: BrushPrimarySchema.optional().default("overgrowth"),
    perceivedSize: z
      .enum(["single_item", "min_pickup", "half_trailer", "three_quarter_trailer", "big_cleanout", "not_sure"])
      .optional()
      .default("not_sure"),
    difficulty: BrushDifficultySchema.optional().default("not_sure"),
    haulAway: z.boolean().optional().default(true),
    otherDetails: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    zip: z.string().min(3),
    photoUrls: z
      .preprocess((value) => (value == null ? undefined : value), z.array(z.string().url().max(2048)).max(10).default([]))
      .refine(
        (urls) =>
          urls.every((url) => {
            try {
              const parsed = new URL(url);
              return parsed.protocol === "http:" || parsed.protocol === "https:";
            } catch {
              return false;
            }
          }),
        { message: "Photo URLs must be http(s) links." }
      )
  }),
  utm: z
    .object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      term: z.string().optional(),
      content: z.string().optional(),
      gclid: z.string().optional(),
      fbclid: z.string().optional()
    })
    .optional()
});

const QuoteResultSchema = z.object({
  loadFractionEstimate: z.number().finite().positive(),
  priceLow: z.number().finite().nonnegative(),
  priceHigh: z.number().finite().nonnegative(),
  displayTierLabel: z.string().min(1).max(120),
  reasonSummary: z.string().min(1).max(500),
  needsInPersonEstimate: z.boolean()
});

type QuoteResult = z.infer<typeof QuoteResultSchema>;

const SYSTEM_PROMPT = `You estimate brush clearing / small land clearing jobs for a junk removal company.

Return ONLY valid JSON matching the schema. Do not include extra keys.
Always protect margins: if uncertain, set needsInPersonEstimate=true rather than underbidding.
Keep displayTierLabel short. reasonSummary should be clear, 1-2 sentences, no jargon.`;

function roundToNearest(value: number, step: number): number {
  if (!Number.isFinite(value)) return value;
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getBaseTier(perceivedSize: string): { low: number; high: number; label: string; load: number } {
  switch (perceivedSize) {
    case "single_item":
      return { low: 650, high: 1100, label: "Small patch", load: 0.25 };
    case "min_pickup":
      return { low: 850, high: 1600, label: "Fence line / side yard", load: 0.5 };
    case "half_trailer":
      return { low: 1200, high: 2400, label: "Backyard section", load: 0.75 };
    case "three_quarter_trailer":
      return { low: 2200, high: 4200, label: "Most of a yard", load: 1.0 };
    case "big_cleanout":
      return { low: 3800, high: 7500, label: "Full lot / heavy clearing", load: 1.5 };
    default:
      return { low: 1200, high: 2800, label: "Brush clearing", load: 1.0 };
  }
}

function applyBrushModifiers(input: {
  tier: { low: number; high: number; label: string; load: number };
  difficulty: "easy" | "moderate" | "hard" | "not_sure";
}): { low: number; high: number; load: number } {
  const difficultyMult =
    input.difficulty === "hard"
      ? 1.4
      : input.difficulty === "easy"
        ? 0.95
        : input.difficulty === "not_sure"
          ? 1.15
          : 1.0;

  const low = input.tier.low * difficultyMult;
  const high = input.tier.high * difficultyMult;
  const load = input.tier.load * (input.difficulty === "hard" ? 1.1 : input.difficulty === "easy" ? 0.97 : 1.0);

  return { low, high, load };
}

function getHaulAwayAddOn(perceivedSize: string): number {
  // Flat add-on is more realistic than a % discount since disposal/haul cost behaves like a fixed cost.
  switch (perceivedSize) {
    case "single_item":
      return 250;
    case "min_pickup":
      return 450;
    case "half_trailer":
      return 650;
    case "three_quarter_trailer":
      return 850;
    case "big_cleanout":
      return 1250;
    default:
      return 850;
  }
}

function decideNeedsEstimate(input: {
  perceivedSize: string;
  primary: string;
  difficulty: string;
  photoCount: number;
}): boolean {
  if (input.perceivedSize === "big_cleanout" || input.perceivedSize === "not_sure") return true;
  if (input.difficulty === "hard") return true;
  if (input.primary === "small_saplings") return true;
  if (input.photoCount <= 0 && input.perceivedSize !== "single_item") return true;
  if (input.photoCount <= 0 && input.difficulty === "not_sure") return true;
  return false;
}

function applyBounds(result: QuoteResult, minLow: number, maxHigh: number): QuoteResult {
  const low = clamp(roundToNearest(result.priceLow, 25), minLow, maxHigh);
  const high = clamp(roundToNearest(result.priceHigh, 25), low, maxHigh);
  const load = clamp(result.loadFractionEstimate, 0.25, 2.5);
  return {
    ...result,
    loadFractionEstimate: load,
    priceLow: low,
    priceHigh: high
  };
}

async function getQuoteFromAi(
  body: z.infer<typeof RequestSchema>,
  bounds: { minLow: number; maxHigh: number; tierLabel: string; load: number; needsEstimate: boolean }
): Promise<QuoteResult> {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = (process.env["OPENAI_MODEL"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
  if (!apiKey) {
    return {
      loadFractionEstimate: bounds.load,
      priceLow: bounds.minLow,
      priceHigh: bounds.maxHigh,
      displayTierLabel: `Brush clearing (${bounds.tierLabel})`,
      reasonSummary: "Estimate based on your selections. Photos help us tighten the range.",
      needsInPersonEstimate: bounds.needsEstimate
    };
  }

  const jobForAi = {
    primary: body.job.primary,
    perceivedSize: body.job.perceivedSize,
    difficulty: body.job.difficulty,
    haulAway: body.job.haulAway,
    zip: body.job.zip,
    otherDetails:
      typeof body.job.otherDetails === "string" && body.job.otherDetails.trim().length > 0
        ? body.job.otherDetails.trim().slice(0, 200)
        : undefined,
    notes:
      typeof body.job.notes === "string" && body.job.notes.trim().length > 0
        ? body.job.notes.trim().slice(0, 600)
        : undefined,
    photoCount: Array.isArray(body.job.photoUrls) ? body.job.photoUrls.length : 0
  };

  const dynamicRules = [
    `priceLow MUST be >= ${bounds.minLow} and priceHigh MUST be <= ${bounds.maxHigh}.`,
    "priceLow and priceHigh MUST be multiples of 25.",
    bounds.needsEstimate
      ? "Set needsInPersonEstimate=true unless you are very confident from the inputs."
      : "Set needsInPersonEstimate=false only if the job sounds straightforward.",
    "displayTierLabel should include the size tier (short)."
  ].join("\n");

  const jsonSchemaFormat = {
    type: "json_schema",
    name: "brush_quote",
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

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: `${SYSTEM_PROMPT}\n\n${dynamicRules}`,
      input: JSON.stringify(jobForAi),
      tools: [],
      tool_choice: "none",
      reasoning: {
        effort: "minimal"
      },
      text: {
        format: jsonSchemaFormat
      },
      max_output_tokens: 900
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ai_failed_${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    output?: unknown;
  };

  const outputItems = Array.isArray((data as any).output) ? ((data as any).output as unknown[]) : [];
  const outputJsonParts: unknown[] = [];
  const outputTextParts: string[] = [];

  for (const item of outputItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = record["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as Record<string, unknown>;
      const partType = typeof typed["type"] === "string" ? typed["type"] : "";
      if (partType === "output_json") {
        const jsonValue = typed["json"] ?? typed["output"] ?? typed["value"];
        if (jsonValue != null) outputJsonParts.push(jsonValue);
      }
      if (partType === "output_text") {
        const textVal = typed["text"];
        if (typeof textVal === "string" && textVal.trim()) outputTextParts.push(textVal.trim());
      }
    }
  }

  const candidate = outputJsonParts[0] ?? outputTextParts.join("\n").trim();
  const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
  const validated = QuoteResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("ai_invalid_response");
  }
  return validated.data;
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  try {
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, {
        status: 400
      });
    }
    const body = parsed.data;

    const normalizedPostalCode = normalizePostalCode(body.job.zip);
    if (normalizedPostalCode && !isGeorgiaPostalCode(normalizedPostalCode)) {
      return corsJson(
        {
          ok: false,
          error: "out_of_area",
          message: "Thanks for reaching out. We currently serve Georgia only."
        },
        requestOrigin
      );
    }

    const tier = getBaseTier(body.job.perceivedSize);
    const modified = applyBrushModifiers({
      tier,
      difficulty: body.job.difficulty
    });

    const photoCount = Array.isArray(body.job.photoUrls) ? body.job.photoUrls.length : 0;
    const needsEstimate = decideNeedsEstimate({
      perceivedSize: body.job.perceivedSize,
      primary: body.job.primary,
      difficulty: body.job.difficulty,
      photoCount
    });

    const minLowFloor = body.job.haulAway ? 850 : 650;
    const minHighFloor = body.job.haulAway ? 1100 : 850;

    const haulAddOn = body.job.haulAway ? getHaulAwayAddOn(body.job.perceivedSize) : 0;
    const pricedLow = modified.low + haulAddOn;
    const pricedHigh = modified.high + haulAddOn;

    const bounds = {
      minLow: clamp(roundToNearest(pricedLow, 25), minLowFloor, 10_000),
      maxHigh: clamp(roundToNearest(pricedHigh, 25), minHighFloor, 10_000),
      tierLabel: tier.label,
      load: clamp(modified.load, 0.25, 2.5),
      needsEstimate
    };
    if (bounds.maxHigh < bounds.minLow) bounds.maxHigh = bounds.minLow;

    const fallback: QuoteResult = {
      loadFractionEstimate: bounds.load,
      priceLow: bounds.minLow,
      priceHigh: bounds.maxHigh,
      displayTierLabel: `Brush clearing (${bounds.tierLabel})`,
      reasonSummary: needsEstimate
        ? "Estimate based on your selections. We may need to confirm details on-site."
        : "Estimate based on your selections. Photos help us tighten the range.",
      needsInPersonEstimate: needsEstimate
    };

    const aiResult = await getQuoteFromAi(body, bounds).catch((err) => {
      console.error("[brush-quote] ai_failed", err instanceof Error ? err.message : err);
      return fallback;
    });

    const base = applyBounds(aiResult, bounds.minLow, bounds.maxHigh);

    const storedAiResult = {
      ...base
    };

    const db = getDb();
    const primaryType = body.job.primary === "other" ? "brush_other" : body.job.primary;
    const [quoteRow] = await db
      .insert(instantQuotes)
      .values({
        source: body.source ?? "public_site",
        contactName: body.contact.name.trim(),
        contactPhone: body.contact.phone.trim(),
        timeframe: body.contact.timeframe,
        zip: body.job.zip.trim(),
        jobTypes: ["brush_clearing", primaryType],
        perceivedSize: body.job.perceivedSize,
        notes: body.job.notes ?? null,
        photoUrls: body.job.photoUrls ?? [],
        aiResult: storedAiResult
      })
      .returning({ id: instantQuotes.id });

    const quoteId = quoteRow?.id ?? null;
    if (quoteId) {
      try {
        const { firstName, lastName } = normalizeName(body.contact.name);
        const normalizedPhone = normalizePhone(body.contact.phone);
        const utm = body.utm ?? {};
        const referrer = request.headers.get("referer") ?? undefined;
        const otherDetails =
          typeof body.job.otherDetails === "string" && body.job.otherDetails.trim().length > 0
            ? body.job.otherDetails.trim()
            : null;

        await db.transaction(async (tx) => {
          const contact = await upsertContact(tx, {
            firstName,
            lastName,
            phoneRaw: normalizedPhone.raw,
            phoneE164: normalizedPhone.e164,
            source: "brush_quote",
            email: null
          });

          const [existingProperty] = await tx
            .select({ id: properties.id })
            .from(properties)
            .where(eq(properties.contactId, contact.id))
            .orderBy(desc(properties.createdAt))
            .limit(1);

          const property =
            existingProperty?.id
              ? { id: existingProperty.id }
              : await upsertProperty(tx, {
                  contactId: contact.id,
                  addressLine1: `[Brush Quote ${quoteId.split("-")[0] ?? quoteId}] ZIP ${body.job.zip.trim()} (address pending)`,
                  city: "Unknown",
                  state: "GA",
                  postalCode: body.job.zip.trim(),
                  gated: false
                });

          const notesParts = [
            body.job.notes ?? null,
            otherDetails ? `Other: ${otherDetails}` : null,
            `Brush type: ${primaryType}`,
            `Difficulty: ${body.job.difficulty}`,
            `Haul away: ${body.job.haulAway ? "yes" : "no"}`
          ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

          const [leadRow] = await tx
            .insert(leads)
            .values({
              contactId: contact.id,
              propertyId: property.id,
              servicesRequested: ["brush_clearing", primaryType],
              notes: notesParts.length ? notesParts.join("\n") : null,
              status: "new",
              source: "brush_quote",
              utmSource: utm.source,
              utmMedium: utm.medium,
              utmCampaign: utm.campaign,
              utmTerm: utm.term,
              utmContent: utm.content,
              gclid: utm.gclid,
              fbclid: utm.fbclid,
              referrer,
              formPayload: {
                instantQuoteId: quoteId,
                timeframe: body.contact.timeframe,
                zip: body.job.zip.trim(),
                primary: body.job.primary,
                perceivedSize: body.job.perceivedSize,
                difficulty: body.job.difficulty,
                haulAway: body.job.haulAway,
                notes: body.job.notes ?? null,
                otherDetails,
                aiResult: storedAiResult
              },
              instantQuoteId: quoteId
            })
            .returning({ id: leads.id });

          if (leadRow?.id) {
            await tx.insert(outboxEvents).values({
              type: "lead.alert",
              payload: {
                leadId: leadRow.id,
                source: "brush_quote"
              }
            });
          }

          const [pipelineRow] = await tx
            .select({ stage: crmPipeline.stage })
            .from(crmPipeline)
            .where(eq(crmPipeline.contactId, contact.id))
            .limit(1);

          const previousStage = typeof pipelineRow?.stage === "string" ? pipelineRow.stage : null;
          if (previousStage !== "quoted") {
            await tx
              .insert(crmPipeline)
              .values({ contactId: contact.id, stage: "quoted" })
              .onConflictDoUpdate({
                target: crmPipeline.contactId,
                set: { stage: "quoted", updatedAt: new Date() }
              });

            await tx.insert(outboxEvents).values({
              type: "pipeline.auto_stage_change",
              payload: {
                contactId: contact.id,
                fromStage: previousStage,
                toStage: "quoted",
                reason: "brush_quote.created",
                meta: {
                  instantQuoteId: quoteId,
                  leadId: leadRow?.id ?? null
                }
              }
            });
          }

          if (leadRow?.id) {
            await tx.insert(outboxEvents).values({
              type: "followup.schedule",
              payload: {
                leadId: leadRow.id,
                contactId: contact.id,
                reason: "brush_quote.created"
              }
            });
          }
        });
      } catch (error) {
        console.error("[brush-quote] lead_create_failed", { quoteId, error: String(error) });
      }
    }

    const discountPercent = await resolveInstantQuoteDiscountPercent(db);
    const discountMultiplier = discountPercent > 0 ? 1 - discountPercent : 1;
    const priceLowDiscounted = discountPercent > 0 ? Math.max(0, Math.round(base.priceLow * discountMultiplier)) : undefined;
    const priceHighDiscounted = discountPercent > 0 ? Math.max(0, Math.round(base.priceHigh * discountMultiplier)) : undefined;

    return corsJson(
      {
        ok: true,
        quoteId,
        quote: {
          ...base,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          priceLowDiscounted: priceLowDiscounted ?? undefined,
          priceHighDiscounted: priceHighDiscounted ?? undefined
        }
      },
      requestOrigin
    );
  } catch (error) {
    console.error("[brush-quote] server_error", error);
    return corsJson({ error: "server_error" }, null, { status: 500 });
  }
}
