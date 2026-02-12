import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, crmPipeline, instantQuotes, leads, outboxEvents, properties } from "@/db";
import { getCompanyProfilePolicy, isGeorgiaPostalCode, normalizePostalCode } from "@/lib/policy";
import { desc, eq } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../web/persistence";
import { normalizeName, normalizePhone } from "../web/utils";
import { JUNK_VOLUME_PRICING, JUNK_VOLUME_UNIT_PRICE } from "@/lib/junk-volume-pricing";

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

const RequestSchema = z.object({
  source: z.string().optional().default("public_site"),
  contact: z.object({
    name: z.string().min(2),
    phone: z.string().min(7),
    timeframe: z.enum(["today", "tomorrow", "this_week", "flexible"]).optional().default("flexible")
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
      .optional()
      .default([]),
    perceivedSize: z
      .enum([
        // New customer-facing size categories
        "single_item",
        "min_pickup",
        "half_trailer",
        "three_quarter_trailer",
        // Backwards-compatible legacy categories
        "few_items",
        "small_area",
        "one_room_or_half_garage",
        // Shared
        "big_cleanout",
        "not_sure"
      ])
      .optional()
      .default("not_sure"),
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

const QuoteResultSchema = z
  .object({
    loadFractionEstimate: z.number(),
    priceLow: z.number(),
    priceHigh: z.number(),
    displayTierLabel: z.string(),
    reasonSummary: z.string(),
    needsInPersonEstimate: z.boolean()
  })
  .superRefine((value, ctx) => {
    if (!Number.isFinite(value.priceLow) || !Number.isFinite(value.priceHigh)) return;
    if (value.priceLow > value.priceHigh) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "priceLow must be <= priceHigh",
        path: ["priceLow"]
      });
    }
    if (value.priceLow < 100 || value.priceHigh < 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prices must be >= 100",
        path: ["priceLow"]
      });
    }
  });

const VOLUME_PRICING = JUNK_VOLUME_PRICING;
const UNIT_PRICE = JUNK_VOLUME_UNIT_PRICE;
type JobInput = z.infer<typeof RequestSchema>["job"];
type QuoteResult = z.infer<typeof QuoteResultSchema>;

type QuoteBounds = {
  minUnits: number;
  maxUnits: number;
  minHighUnits?: number;
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.trunc(value);
}

function unitsToPrice(units: number): number {
  if (units <= 0) return VOLUME_PRICING.singleItem;
  return units * UNIT_PRICE;
}

function priceToUnits(price: number): number {
  if (price === VOLUME_PRICING.singleItem) return 0;
  return Math.round(price / UNIT_PRICE);
}

function getQuoteBounds(job: JobInput): QuoteBounds {
  let minUnits = 2;
  let maxUnits = 4;
  let minHighUnits: number | undefined;

  switch (job.perceivedSize) {
    case "single_item":
    case "few_items":
      minUnits = 0;
      maxUnits = 0;
      break;
    case "min_pickup":
      minUnits = 1;
      maxUnits = 1;
      break;
    case "half_trailer":
      minUnits = 2;
      maxUnits = 2;
      break;
    case "three_quarter_trailer":
      // Many customers interpret "large" as "about a full trailer" (especially when items are spread out).
      // Allow a 3/4-to-full range to reduce accidental oversizing into the multi-load category.
      minUnits = 3;
      maxUnits = 4;
      break;
    case "small_area":
      minUnits = 1;
      maxUnits = 2;
      break;
    case "one_room_or_half_garage":
      minUnits = 2;
      maxUnits = 3;
      break;
    case "big_cleanout":
      minUnits = 4;
      maxUnits = 8;
      break;
    case "not_sure":
    default:
      minUnits = 2;
      maxUnits = 4;
      break;
  }

  const types = new Set(job.types);
  if (types.has("hot_tub_playset")) {
    minUnits = Math.max(minUnits, 3);
    maxUnits = Math.max(maxUnits, 6);
    minHighUnits = Math.max(minHighUnits ?? 0, 4) || undefined;
  }

  if (types.has("business_commercial") && job.perceivedSize === "big_cleanout") {
    minUnits = Math.max(minUnits, 4);
    maxUnits = Math.max(maxUnits, 8);
    minHighUnits = Math.max(minHighUnits ?? 0, 6) || undefined;
  }

  return {
    minUnits: clampInt(minUnits, 0, 50),
    maxUnits: clampInt(maxUnits, 0, 50),
    minHighUnits: typeof minHighUnits === "number" ? clampInt(minHighUnits, 0, 50) : undefined
  };
}

function formatLoadCount(units: number): string {
  const loads = units / 4;
  return Number.isInteger(loads) ? String(loads) : loads.toFixed(2).replace(/\.?0+$/u, "");
}

function formatFraction(units: number): string {
  if (units === 0) return "Single item";
  if (units === 1) return "1/4";
  if (units === 2) return "1/2";
  if (units === 3) return "3/4";
  if (units === 4) return "Full";
  return formatLoadCount(units);
}

function formatTierLabel(minUnits: number, maxUnits: number): string {
  if (minUnits === maxUnits) {
    if (minUnits === 0) return "Single item pickup";
    if (minUnits === 1) return "Small pickup (2-4 items)";
    if (minUnits <= 4) return minUnits === 4 ? "Full trailer" : `${formatFraction(minUnits)} trailer`;
    return `${formatLoadCount(minUnits)} trailer loads`;
  }

  if (maxUnits <= 4) {
    const left = minUnits === 2 ? "Half" : formatFraction(minUnits);
    const right = maxUnits === 2 ? "Half" : formatFraction(maxUnits);
    return `${left} to ${right} trailer`;
  }

  const left = minUnits === 4 ? "1" : minUnits < 4 ? formatFraction(minUnits) : formatLoadCount(minUnits);
  return `${left} to ${formatLoadCount(maxUnits)} trailer loads`;
}

function shouldMentionMultiLoad(job: JobInput, bounds: QuoteBounds, priceHigh: number): boolean {
  if (job.perceivedSize === "big_cleanout") return true;
  if ((bounds.minHighUnits ?? 0) > 4) return true;
  return priceHigh > VOLUME_PRICING.full;
}

function applyBoundsToQuote(quote: QuoteResult, job: JobInput, bounds: QuoteBounds): QuoteResult {
  const minUnits = Math.max(0, bounds.minUnits);
  const maxUnits = Math.max(minUnits, bounds.maxUnits);
  const minPrice = unitsToPrice(minUnits);
  const maxPrice = unitsToPrice(maxUnits);
  const minHighUnits = bounds.minHighUnits ? clampInt(bounds.minHighUnits, minUnits, maxUnits) : undefined;
  const minHighPrice = typeof minHighUnits === "number" ? unitsToPrice(minHighUnits) : null;

  const allowedPrices: number[] = [];
  for (let units = minUnits; units <= maxUnits; units++) {
    allowedPrices.push(unitsToPrice(units));
  }

  const pickClosest = (value: number): number => {
    let best = allowedPrices[0] ?? minPrice;
    let bestDistance = Math.abs(best - value);
    for (const candidate of allowedPrices) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  };

  const pickNextUp = (value: number): number => {
    for (const candidate of allowedPrices) {
      if (candidate >= value) return candidate;
    }
    return allowedPrices[allowedPrices.length - 1] ?? maxPrice;
  };

  let priceLow = quote.priceLow;
  let priceHigh = quote.priceHigh;
  if (!Number.isFinite(priceLow)) priceLow = minPrice;
  if (!Number.isFinite(priceHigh)) priceHigh = maxPrice;

  priceLow = clampInt(priceLow, minPrice, maxPrice);
  priceHigh = clampInt(priceHigh, minPrice, maxPrice);

  priceLow = pickClosest(priceLow);
  priceHigh = pickClosest(priceHigh);

  // "Big cleanout" quotes should keep the *low end* anchored at a single full trailer load.
  // Many customers select this when items are spread across multiple rooms but still fit in ~1 load.
  if (job.perceivedSize === "big_cleanout" && priceLow > minPrice) {
    priceLow = minPrice;
  }

  if (minHighPrice && priceHigh < minHighPrice) {
    priceHigh = pickNextUp(minHighPrice);
  }
  if (priceLow > priceHigh) {
    priceLow = priceHigh;
  }

  const lowUnits = priceToUnits(priceLow);
  const highUnits = priceToUnits(priceHigh);
  const avgUnits = (lowUnits + highUnits) / 2;
  const loadFractionEstimate = Math.round((avgUnits / 4) * 100) / 100;

  const tier = formatTierLabel(lowUnits, highUnits);
  const needsInPersonEstimate = Boolean(
    quote.needsInPersonEstimate ||
      job.perceivedSize === "not_sure" ||
      job.perceivedSize === "big_cleanout"
  );

  const forcedMultiLoad = shouldMentionMultiLoad(job, bounds, priceHigh);
  const genericReason = forcedMultiLoad
    ? "Based on your answers, this range may span multiple trailer loads depending on actual volume. Final price is confirmed on site before we start loading."
    : "Based on your answers, this range matches our trailer volume pricing.";

  const mentionsMultipleLoads = (text: string): boolean => {
    const normalized = text.toLowerCase();
    if (normalized.includes("more than one")) return true;
    if (normalized.includes("multiple")) return true;
    if (normalized.includes("multi-trailer") || normalized.includes("multi trailer")) return true;
    if (/\b([2-9]|[1-9]\d+|two|three|four|five)\s*(trailer\s*)?loads?\b/iu.test(normalized)) return true;
    if (/\b1\.\d+\s*(trailer\s*)?loads?\b/iu.test(normalized)) return true;
    return false;
  };

  const providedReason = typeof quote.reasonSummary === "string" ? quote.reasonSummary.trim() : "";
  let reasonSummary = providedReason || genericReason;

  if (forcedMultiLoad && !mentionsMultipleLoads(reasonSummary)) {
    reasonSummary = genericReason;
  }
  if (!forcedMultiLoad && mentionsMultipleLoads(reasonSummary)) {
    reasonSummary = genericReason;
  }

  return {
    ...quote,
    loadFractionEstimate,
    priceLow,
    priceHigh,
    displayTierLabel: tier,
    reasonSummary,
    needsInPersonEstimate
  };
}

function getFallbackQuote(job: JobInput, bounds: QuoteBounds): QuoteResult {
  const minUnits = Math.max(0, bounds.minUnits);
  const maxUnits = Math.max(minUnits, bounds.maxUnits);
  const minHighUnits = bounds.minHighUnits ? clampInt(bounds.minHighUnits, minUnits, maxUnits) : undefined;
  const highUnits = Math.max(maxUnits, minHighUnits ?? maxUnits);

  const priceLow = unitsToPrice(minUnits);
  const priceHigh = unitsToPrice(highUnits);
  const tier = formatTierLabel(minUnits, highUnits);

  const avgUnits = (minUnits + highUnits) / 2;
  const loadFractionEstimate = Math.round((avgUnits / 4) * 100) / 100;

  const needsInPersonEstimate =
    job.perceivedSize === "not_sure" ||
    job.perceivedSize === "big_cleanout";

  const mentionMultiLoad = shouldMentionMultiLoad(job, bounds, priceHigh);
  const reasonSummary = mentionMultiLoad
    ? "Based on your selected size, this range may span multiple trailer loads depending on actual volume. Final price is confirmed on site before we start loading."
    : "Based on your selected size, this range matches our trailer volume pricing.";

  return {
    loadFractionEstimate,
    priceLow,
    priceHigh,
    displayTierLabel: tier,
    reasonSummary,
    needsInPersonEstimate
  };
}

export async function POST(request: NextRequest) {
  try {
    const requestOrigin = request.headers.get("origin");
    const parsed = RequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        const details = parsed.error.flatten();
        console.warn("[junk-quote] invalid_payload", details);

        let message = "Invalid request. Please check the form and try again.";
        const contactErrors = details.fieldErrors.contact ?? [];
        const jobErrors = details.fieldErrors.job ?? [];

        const hasPhotoIssue = parsed.error.issues.some(
          (issue) => issue.path?.[0] === "job" && issue.path?.[1] === "photoUrls"
        );

        if (hasPhotoIssue) {
          message = "Those photos were too large to attach. Please try smaller photos or skip photos for now.";
        } else if (contactErrors.some((err) => /at least 7 character/u.test(err))) {
          message = "Please enter a valid phone number.";
        } else if (contactErrors.some((err) => /at least 2 character/u.test(err))) {
          message = "Please enter your name.";
        } else if (jobErrors.some((err) => /at least 3 character/u.test(err))) {
          message = "Please enter a valid ZIP code.";
        }

        return corsJson({ ok: false, error: "invalid_payload", message, details }, requestOrigin, { status: 400 });
      }
      const body = parsed.data;

      const normalizedPostalCode = normalizePostalCode(body.job.zip);
      if (normalizedPostalCode && !isGeorgiaPostalCode(normalizedPostalCode)) {
        return corsJson({
          ok: false,
          error: "out_of_area",
          message: "Thanks for reaching out. We currently serve Georgia only."
        }, requestOrigin);
      }
      const bounds = getQuoteBounds(body.job);
    const fallback = getFallbackQuote(body.job, bounds);
    const aiResult = await getQuoteFromAi(body, bounds).catch((err) => {
      console.error("[junk-quote] ai_failed", err instanceof Error ? err.message : err);
      return fallback;
    });
    const aiValidated = QuoteResultSchema.safeParse(aiResult);
    const baseCandidate = aiValidated.success ? aiValidated.data : fallback;
    if (!aiValidated.success) {
      console.error("[junk-quote] ai_invalid_response", aiResult);
    }

    const base = applyBoundsToQuote(baseCandidate, body.job, bounds);

    const storedAiResult = {
      ...base
    };

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

        await db.transaction(async (tx) => {
          const contact = await upsertContact(tx, {
            firstName,
            lastName,
            phoneRaw: normalizedPhone.raw,
            phoneE164: normalizedPhone.e164,
            source: "instant_quote"
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
                  addressLine1: `[Instant Quote ${quoteId.split("-")[0] ?? quoteId}] ZIP ${body.job.zip.trim()} (address pending)`,
                  city: "Unknown",
                  state: "GA",
                  postalCode: body.job.zip.trim(),
                  gated: false
                });

          const [leadRow] = await tx
            .insert(leads)
            .values({
              contactId: contact.id,
              propertyId: property.id,
              servicesRequested: body.job.types,
              notes: body.job.notes ?? null,
              status: "new",
              source: "instant_quote",
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
                jobTypes: body.job.types,
                perceivedSize: body.job.perceivedSize,
                notes: body.job.notes ?? null,
                aiResult: storedAiResult,
                utm
              },
              instantQuoteId: quoteId
            })
            .returning({ id: leads.id });

          if (leadRow?.id) {
            await tx.insert(outboxEvents).values({
              type: "lead.alert",
              payload: {
                leadId: leadRow.id,
                source: "instant_quote"
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
                reason: "instant_quote.created",
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
                reason: "instant_quote.created"
              }
            });
          }
        });
      } catch (error) {
        console.error("[junk-quote] lead_create_failed", { quoteId, error: String(error) });
      }
    }

    const discountPercent = await resolveInstantQuoteDiscountPercent(db);
    const discountMultiplier = discountPercent > 0 ? 1 - discountPercent : 1;
    const priceLowDiscounted =
      discountPercent > 0 ? Math.max(0, Math.round(base.priceLow * discountMultiplier)) : undefined;
    const priceHighDiscounted =
      discountPercent > 0 ? Math.max(0, Math.round(base.priceHigh * discountMultiplier)) : undefined;

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
    console.error("[junk-quote] server_error", error);
    return corsJson({ error: "server_error" }, null, { status: 500 });
  }
}

async function getQuoteFromAi(body: z.infer<typeof RequestSchema>, bounds: QuoteBounds) {
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

  const jobForAi = {
    types: body.job.types,
    perceivedSize: body.job.perceivedSize,
    zip: body.job.zip,
    notes:
      typeof body.job.notes === "string" && body.job.notes.trim().length > 0
        ? body.job.notes.trim().slice(0, 600)
        : undefined,
    photoCount: Array.isArray(body.job.photoUrls) ? body.job.photoUrls.length : 0
  };
  const jobForAiInput = JSON.stringify(jobForAi);

  async function requestOpenAi(format: TextFormat) {
    const allowedUnits = Array.from(
      { length: Math.max(0, bounds.maxUnits - bounds.minUnits + 1) },
      (_, i) => bounds.minUnits + i
    );
    const allowedPrices = allowedUnits.map((u) => unitsToPrice(u));
    const minHighPrice = typeof bounds.minHighUnits === "number" ? unitsToPrice(bounds.minHighUnits) : null;

    const mustMentionMultiLoad = shouldMentionMultiLoad(body.job, bounds, minHighPrice ?? unitsToPrice(bounds.maxUnits));
    const dynamicRules = [
      `Allowed prices for this request are ONLY: ${allowedPrices.join(", ")}.`,
      minHighPrice ? `Because of the job size/type, priceHigh MUST be >= ${minHighPrice}.` : null,
      mustMentionMultiLoad
        ? `Your reasonSummary MUST mention that the job may require more than one trailer load.`
        : `Do NOT mention multi-loads unless it could realistically be multiple loads.`
    ]
      .filter(Boolean)
      .join("\n");

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: `${SYSTEM_PROMPT}\n\n${dynamicRules}`,
        input: jobForAiInput,
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
    const outputJsonParts: unknown[] = [];
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
          if (partType === "output_json") {
            const jsonValue = typed["json"] ?? typed["output"] ?? typed["value"];
            if (jsonValue != null) {
              outputJsonParts.push(jsonValue);
            }
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

    if (outputJsonParts.length) {
      const candidate = outputJsonParts[0];
      if (typeof candidate === "string") {
        return JSON.parse(candidate);
      }
      return candidate;
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
    if (error instanceof Error && /exceeds the context window/u.test(error.message)) {
      throw error;
    }
    console.error("[junk-quote] ai_retrying_with_json_object", error instanceof Error ? error.message : error);
    return await requestOpenAi("json_object");
  }
}

const SYSTEM_PROMPT = `
You are the quoting assistant for Stonegate Junk Removal in Woodstock, Georgia.
Stonegate uses one large 7x16x4 dump trailer. Pricing is based on either a single-item pickup or trailer volume.
Do NOT add charges for weight, stairs, distance, time, urgency, heavy/bulky items, or difficulty.

Base prices:
- Single item pickup: $100
- 1/4 trailer: $175
- 1/2 trailer: $350
- 3/4 trailer: $525
- Full trailer: $700

Multi-load jobs:
- If you believe the job can require more than one trailer load, you may quote above $600.
- Use the base prices above as reference and keep priceLow/priceHigh aligned to realistic trailer-load amounts (avoid odd, non-tier numbers).

Rules:
- Respond ONLY with JSON: { "loadFractionEstimate": number, "priceLow": number, "priceHigh": number, "displayTierLabel": string, "reasonSummary": string, "needsInPersonEstimate": boolean }
- Always return priceLow and priceHigh. They may be equal if the range is very tight.
- Map perceived size to trailer fraction:
  single_item -> single item pickup
  min_pickup -> 1/4 trailer minimum pickup
  half_trailer -> 1/2 trailer
  three_quarter_trailer -> 3/4 trailer
  big_cleanout -> 1.0-2.0 trailer loads (can be multiple loads)
  not_sure -> err on 0.5+ unless clearly tiny
- Use the base prices above; do not invent unrelated pricing schemes.
- If the job seems uncertain or could be multiple loads, widen the range and set needsInPersonEstimate=true.
- displayTierLabel: short category like "Small load", "Half trailer", "Large to full trailer", "Multi-trailer project".
- reasonSummary: one friendly sentence.
`.trim();
