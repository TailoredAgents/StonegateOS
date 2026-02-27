import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { getDb, crmPipeline, instantQuotes, leads, outboxEvents, properties } from "@/db";
import { getCompanyProfilePolicy, isGeorgiaPostalCode, normalizePostalCode } from "@/lib/policy";
import { desc, eq } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../web/persistence";
import { normalizeName, normalizePhone } from "../web/utils";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
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

function resolveDemoFixedDiscountDollars(): number {
  const envRaw = process.env["INSTANT_QUOTE_DISCOUNT_DEMO_AMOUNT"];
  const envValue = envRaw ? Number(envRaw) : NaN;
  if (Number.isFinite(envValue) && envValue > 0) return Math.round(envValue);
  return 100;
}

const DemoTypeSchema = z.enum([
  "deck",
  "fence",
  "shed",
  "kitchen_bath",
  "drywall",
  "concrete",
  "hot_tub_playset",
  "other"
]);

const DemoSizeSchema = z.enum([
  // deck
  "deck_small",
  "deck_medium",
  "deck_large",
  "deck_xl",
  // fence
  "fence_0_50",
  "fence_50_150",
  "fence_150_300",
  "fence_300_plus",
  // shed
  "shed_small",
  "shed_medium",
  "shed_large",
  "shed_xl",
  // kitchen/bath
  "rooms_1",
  "rooms_2",
  "rooms_3_plus",
  // drywall
  "drywall_1_room",
  "drywall_2_3_rooms",
  "drywall_whole_floor",
  // concrete
  "concrete_0_100",
  "concrete_100_250",
  "concrete_250_600",
  "concrete_600_plus",
  // hot tub/playset
  "hot_tub_small",
  "hot_tub_standard",
  "hot_tub_large",
  "hot_tub_not_sure",
  // other
  "other_small",
  "other_medium",
  "other_large",
  "other_not_sure"
]);

const RequestSchema = z.object({
  source: z.string().optional().default("public_site"),
  contact: z.object({
    name: z.string().min(2),
    phone: z.string().min(7),
    timeframe: z.enum(["today", "tomorrow", "this_week", "flexible"]).optional().default("flexible")
  }),
  job: z
    .object({
      type: DemoTypeSchema,
      size: DemoSizeSchema,
      haulAway: z.boolean().optional().default(true),
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
        ),
      otherDetails: z.string().optional().nullable()
    })
    .superRefine((value, ctx) => {
      const { type, size } = value;
      const ok = (() => {
        if (type === "deck") return size.startsWith("deck_");
        if (type === "fence") return size.startsWith("fence_");
        if (type === "shed") return size.startsWith("shed_");
        if (type === "kitchen_bath") return size.startsWith("rooms_");
        if (type === "drywall") return size.startsWith("drywall_");
        if (type === "concrete") return size.startsWith("concrete_");
        if (type === "hot_tub_playset") return size.startsWith("hot_tub_");
        if (type === "other") return size.startsWith("other_");
        return false;
      })();
      if (!ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: "Invalid size option for this demo type." });
      }
      if (type === "other" && (!value.otherDetails || value.otherDetails.trim().length < 3)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["otherDetails"], message: "Please describe what you need demolished." });
      }
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

type QuoteResult = z.infer<typeof QuoteResultSchema>;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function roundToNearest(value: number, increment: number): number {
  if (!Number.isFinite(value)) return value;
  if (increment <= 0) return value;
  return Math.round(value / increment) * increment;
}

function sizeLabel(type: z.infer<typeof DemoTypeSchema>, size: z.infer<typeof DemoSizeSchema>): string {
  const labels: Record<string, string> = {
    deck_small: "Small deck",
    deck_medium: "Medium deck",
    deck_large: "Large deck",
    deck_xl: "XL deck",
    fence_0_50: "0–50 ft fence",
    fence_50_150: "50–150 ft fence",
    fence_150_300: "150–300 ft fence",
    fence_300_plus: "300+ ft fence",
    shed_small: "Small shed",
    shed_medium: "Medium shed",
    shed_large: "Large shed",
    shed_xl: "XL shed",
    rooms_1: "1 room",
    rooms_2: "2 rooms",
    rooms_3_plus: "3+ rooms",
    drywall_1_room: "1 room drywall",
    drywall_2_3_rooms: "2–3 rooms drywall",
    drywall_whole_floor: "Whole-floor drywall",
    concrete_0_100: "0–100 sq ft concrete",
    concrete_100_250: "100–250 sq ft concrete",
    concrete_250_600: "250–600 sq ft concrete",
    concrete_600_plus: "600+ sq ft concrete",
    hot_tub_small: "Small hot tub/playset",
    hot_tub_standard: "Standard hot tub/playset",
    hot_tub_large: "Large hot tub/playset",
    hot_tub_not_sure: "Hot tub/playset (not sure)",
    other_small: "Small demo",
    other_medium: "Medium demo",
    other_large: "Large demo",
    other_not_sure: "Demo (not sure)"
  };
  const fallback = type === "kitchen_bath" ? "Interior demo" : "Demo";
  return labels[size] ?? fallback;
}

function computeBaseRange(input: {
  type: z.infer<typeof DemoTypeSchema>;
  size: z.infer<typeof DemoSizeSchema>;
  haulAway: boolean;
}): { low: number; high: number; needsEstimate: boolean; load: number } {
  const pile = !input.haulAway;
  const needsEstimate = true;
  const lowHighBySize: { pile: [number, number]; haul: [number, number]; load: number } = (() => {
    switch (input.size) {
      case "deck_small":
        return { pile: [350, 650], haul: [450, 850], load: 0.25 };
      case "deck_medium":
        return { pile: [550, 1050], haul: [750, 1400], load: 0.5 };
      case "deck_large":
        return { pile: [900, 1700], haul: [1200, 2200], load: 0.75 };
      case "deck_xl":
        return { pile: [1500, 3000], haul: [2000, 3800], load: 1.25 };

      case "fence_0_50":
        return { pile: [350, 650], haul: [450, 850], load: 0.25 };
      case "fence_50_150":
        return { pile: [450, 900], haul: [650, 1200], load: 0.5 };
      case "fence_150_300":
        return { pile: [650, 1400], haul: [900, 1800], load: 0.75 };
      case "fence_300_plus":
        return { pile: [1000, 2400], haul: [1400, 3000], load: 1.25 };

      case "shed_small":
        return { pile: [350, 650], haul: [450, 850], load: 0.25 };
      case "shed_medium":
        return { pile: [450, 1000], haul: [650, 1300], load: 0.5 };
      case "shed_large":
        return { pile: [650, 1400], haul: [900, 1800], load: 0.75 };
      case "shed_xl":
        return { pile: [1000, 2400], haul: [1400, 3000], load: 1.25 };

      case "rooms_1":
        return { pile: [450, 1000], haul: [650, 1400], load: 0.5 };
      case "rooms_2":
        return { pile: [900, 1800], haul: [1200, 2400], load: 1.0 };
      case "rooms_3_plus":
        return { pile: [1300, 3000], haul: [1800, 3800], load: 1.5 };

      case "drywall_1_room":
        return { pile: [350, 650], haul: [450, 850], load: 0.25 };
      case "drywall_2_3_rooms":
        return { pile: [550, 1200], haul: [750, 1600], load: 0.75 };
      case "drywall_whole_floor":
        return { pile: [1000, 2600], haul: [1400, 3200], load: 1.5 };

      case "concrete_0_100":
        return { pile: [750, 1400], haul: [900, 1800], load: 0.5 };
      case "concrete_100_250":
        return { pile: [1100, 2200], haul: [1400, 2800], load: 1.0 };
      case "concrete_250_600":
        return { pile: [1900, 3800], haul: [2400, 4800], load: 1.5 };
      case "concrete_600_plus":
        return { pile: [3000, 6500], haul: [3800, 8000], load: 2.0 };

      case "hot_tub_small":
        return { pile: [350, 700], haul: [450, 900], load: 0.25 };
      case "hot_tub_standard":
        return { pile: [450, 1000], haul: [650, 1300], load: 0.5 };
      case "hot_tub_large":
        return { pile: [650, 1600], haul: [900, 2000], load: 0.75 };
      case "hot_tub_not_sure":
        return { pile: [550, 1400], haul: [750, 1800], load: 0.75 };

      case "other_small":
        return { pile: [350, 700], haul: [450, 900], load: 0.25 };
      case "other_medium":
        return { pile: [550, 1200], haul: [750, 1600], load: 0.75 };
      case "other_large":
        return { pile: [1000, 2600], haul: [1400, 3200], load: 1.5 };
      case "other_not_sure":
      default:
        return { pile: [650, 1800], haul: [900, 2400], load: 1.0 };
    }
  })();

  const [low, high] = pile ? lowHighBySize.pile : lowHighBySize.haul;
  return { low, high, needsEstimate, load: lowHighBySize.load };
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  try {
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, { status: 400 });
    }

    const body = parsed.data;
    const normalizedPostalCode = normalizePostalCode(body.job.zip);
    if (!normalizedPostalCode || !isGeorgiaPostalCode(normalizedPostalCode)) {
      return corsJson(
        {
          ok: false,
          error: "out_of_area",
          message: "Thanks for reaching out. We currently serve North Georgia only."
        },
        requestOrigin,
        { status: 400 }
      );
    }

    const base = computeBaseRange({
      type: body.job.type,
      size: body.job.size,
      haulAway: body.job.haulAway
    });

    const isConcrete = body.job.type === "concrete" || body.job.size.startsWith("concrete_");
    const minLowFloor = isConcrete ? 900 : body.job.haulAway ? 450 : 350;
    const minHighFloor = isConcrete ? 900 : body.job.haulAway ? 450 : 350;

    const boundedLow = clamp(roundToNearest(base.low, 25), minLowFloor, 25_000);
    const boundedHigh = clamp(roundToNearest(base.high, 25), minHighFloor, 25_000);
    const minLow = Math.min(boundedLow, boundedHigh);
    const maxHigh = Math.max(boundedLow, boundedHigh);

    const label = sizeLabel(body.job.type, body.job.size);
    const quote: QuoteResult = {
      loadFractionEstimate: clamp(base.load, 0.1, 4),
      priceLow: minLow,
      priceHigh: maxHigh,
      displayTierLabel: `Demo (${label})`,
      reasonSummary: "Estimate based on your selections. We’ll confirm details on-site before we start.",
      needsInPersonEstimate: Boolean(base.needsEstimate)
    };

    const db = getDb();
    const storedAiResult = {
      ...quote,
      meta: {
        demoType: body.job.type,
        demoSize: body.job.size,
        haulAway: body.job.haulAway
      }
    };

    const serviceKeys: string[] = ["demo-hauloff", `demo_${body.job.type}`];
    if (isConcrete && !serviceKeys.includes("concrete")) serviceKeys.push("concrete");

    const [quoteRow] = await db
      .insert(instantQuotes)
      .values({
        source: body.source ?? "public_site",
        contactName: body.contact.name.trim(),
        contactPhone: body.contact.phone.trim(),
        timeframe: body.contact.timeframe,
        zip: body.job.zip.trim(),
        jobTypes: serviceKeys,
        perceivedSize: body.job.size,
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
          typeof body.job.otherDetails === "string" && body.job.otherDetails.trim().length > 0 ? body.job.otherDetails.trim() : null;

        await db.transaction(async (tx) => {
          const contact = await upsertContact(tx, {
            firstName,
            lastName,
            phoneRaw: normalizedPhone.raw,
            phoneE164: normalizedPhone.e164,
            source: "demo_quote",
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
                  addressLine1: `[Demo Quote ${quoteId.split("-")[0] ?? quoteId}] ZIP ${body.job.zip.trim()} (address pending)`,
                  city: "Unknown",
                  state: "GA",
                  postalCode: body.job.zip.trim(),
                  gated: false
                });

          const notesParts = [
            body.job.notes ?? null,
            otherDetails ? `Other: ${otherDetails}` : null,
            `Demo: ${body.job.type}`,
            `Size: ${label}`,
            `Haul away: ${body.job.haulAway ? "yes" : "no"}`
          ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

          const [leadRow] = await tx
            .insert(leads)
            .values({
              contactId: contact.id,
              propertyId: property.id,
              servicesRequested: serviceKeys,
              notes: notesParts.length ? notesParts.join("\n") : null,
              status: "new",
              source: "demo_quote",
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
                demoType: body.job.type,
                demoSize: body.job.size,
                haulAway: body.job.haulAway,
                notes: body.job.notes ?? null,
                otherDetails,
                photoUrls: body.job.photoUrls ?? [],
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
                source: "demo_quote"
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
                reason: "demo_quote.created",
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
                reason: "demo_quote.created"
              }
            });
          }
        });
      } catch (error) {
        console.error("[demo-quote] lead_create_failed", { quoteId, error: String(error) });
      }
    }

    const discountAmount = resolveDemoFixedDiscountDollars();
    const priceLowDiscounted = discountAmount > 0 ? Math.max(0, quote.priceLow - discountAmount) : undefined;
    const priceHighDiscounted = discountAmount > 0 ? Math.max(0, quote.priceHigh - discountAmount) : undefined;

    return corsJson(
      {
        ok: true,
        quoteId,
        quote: {
          ...quote,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          priceLowDiscounted: priceLowDiscounted ?? undefined,
          priceHighDiscounted: priceHighDiscounted ?? undefined
        }
      },
      requestOrigin
    );
  } catch (error) {
    console.error("[demo-quote] server_error", error);
    return corsJson({ error: "server_error" }, null, { status: 500 });
  }
}
