import { randomUUID } from "node:crypto";
import { resolveOpenAiApiEndpoint } from "@myst-os/sdk";
import { z } from "zod";
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { auditLogs, blogPosts, getDb, seoAgentState } from "@/db";
import { getCompanyProfilePolicy } from "@/lib/policy";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { SEO_TOPICS, type SeoTopic } from "./topics";

const DEFAULT_BRAIN_MODEL = "gpt-5-mini";
const VOICE_MODEL = "gpt-4.1-mini";
const AUTOPUBLISH_LAST_KEY = "blog_autopublish_last";
const BRIEF_FALLBACK_MODEL = "gpt-4.1-mini";
const SERVICE_CITIES = [
  "Canton",
  "Woodstock",
  "Marietta",
  "Acworth",
  "Kennesaw",
  "Roswell",
  "Alpharetta",
  "Holly Springs",
  "Milton",
  "Johns Creek",
] as const;
const PRIMARY_SERVICE_CITIES = [
  "Woodstock",
  "Marietta",
  "Canton",
  "Roswell",
  "Alpharetta",
  "Acworth",
] as const;
const SERVICE_STATE = "GA";

const AREA_SLUGS_BY_TOPIC_CITY_KEY: Record<
  string,
  { city: string; slug: string }
> = {
  canton: { city: "Canton", slug: "canton" },
  woodstock: { city: "Woodstock", slug: "woodstock" },
  marietta: { city: "Marietta", slug: "marietta" },
  acworth: { city: "Acworth", slug: "acworth" },
  kennesaw: { city: "Kennesaw", slug: "kennesaw" },
  roswell: { city: "Roswell", slug: "roswell" },
  alpharetta: { city: "Alpharetta", slug: "alpharetta" },
  "holly-springs": { city: "Holly Springs", slug: "holly-springs" },
  milton: { city: "Milton", slug: "milton" },
  "johns-creek": { city: "Johns Creek", slug: "johns-creek" },
};

type OpenAIResponsesData = {
  output?: unknown;
  output_text?: unknown;
};

type SeoDatabase = ReturnType<typeof getDb>;
type SeoTransaction = Parameters<SeoDatabase["transaction"]>[0] extends (
  tx: infer Transaction,
) => Promise<unknown>
  ? Transaction
  : never;
type SeoDbExecutor = SeoDatabase | SeoTransaction;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstArrayItem(value: unknown): unknown {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  return items[0] ?? null;
}

function pickAnchorCity(
  topicKey: string,
): (typeof PRIMARY_SERVICE_CITIES)[number] {
  const key = topicKey.trim() || "topic";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const idx = PRIMARY_SERVICE_CITIES.length
    ? hash % PRIMARY_SERVICE_CITIES.length
    : 0;
  return PRIMARY_SERVICE_CITIES[idx] ?? "Woodstock";
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextFromContentChunk(chunk: unknown): string | null {
  if (!isRecord(chunk)) return null;

  const type = typeof chunk["type"] === "string" ? chunk["type"] : null;
  const chunkContent = chunk["content"];

  if (type === "message" && Array.isArray(chunkContent)) {
    const parts: string[] = [];
    for (const sub of chunkContent) {
      const value = extractTextFromContentChunk(sub);
      if (value) parts.push(value);
    }
    if (parts.length) return parts.join("\n").trim();
  }

  if (type === "output_text") {
    const text = chunk["text"];
    if (typeof text === "string" && text.trim()) return text.trim();
    if (
      isRecord(text) &&
      typeof text["value"] === "string" &&
      text["value"].trim()
    ) {
      return text["value"].trim();
    }
    if (isRecord(text)) {
      try {
        const serialized = JSON.stringify(text);
        if (serialized && serialized !== "{}") return serialized;
      } catch {
        // ignore
      }
    }
  }

  if (type === "text") {
    const text = chunk["text"];
    if (typeof text === "string" && text.trim()) return text.trim();
    if (
      isRecord(text) &&
      typeof text["value"] === "string" &&
      text["value"].trim()
    ) {
      return text["value"].trim();
    }
  }

  if (type === "refusal") {
    const refusal = chunk["refusal"];
    if (typeof refusal === "string" && refusal.trim()) return refusal.trim();
  }

  if (type === "output_json") {
    if (isRecord(chunk["json"])) {
      try {
        return JSON.stringify(chunk["json"]);
      } catch {
        return null;
      }
    }
  }

  if (Array.isArray(chunkContent)) {
    const parts: string[] = [];
    for (const sub of chunkContent) {
      const value = extractTextFromContentChunk(sub);
      if (value) parts.push(value);
    }
    if (parts.length) return parts.join("\n").trim();
  }

  const text = chunk["text"];
  if (typeof text === "string" && text.trim()) return text.trim();
  if (isRecord(text)) {
    if (typeof text["value"] === "string" && text["value"].trim()) {
      return text["value"].trim();
    }
    if (typeof text["text"] === "string" && text["text"].trim()) {
      return text["text"].trim();
    }
    try {
      const serialized = JSON.stringify(text);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // ignore
    }
  }

  const refusal = chunk["refusal"];
  if (typeof refusal === "string" && refusal.trim()) return refusal.trim();

  if (isRecord(chunk["json"])) {
    try {
      return JSON.stringify(chunk["json"]);
    } catch {
      return null;
    }
  }

  return null;
}

function extractOpenAIResponseText(data: OpenAIResponsesData): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (data.output_text && typeof data.output_text === "object") {
    try {
      const serialized = JSON.stringify(data.output_text);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // ignore
    }
  }

  const outputItems = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of outputItems) {
    const content =
      isRecord(item) && Array.isArray(item["content"]) ? item["content"] : [];
    for (const chunk of content) {
      const value = extractTextFromContentChunk(chunk);
      if (value) parts.push(value);
    }
  }
  return parts.join("\n").trim();
}

async function fetchOpenAIText(
  apiKey: string,
  payload: Record<string, unknown>,
  modelLabel: string,
) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(resolveOpenAiApiEndpoint("responses", process.env), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.warn("[seo] openai.request_failed", {
        model: modelLabel,
        status: "fetch_error",
        error: String(error),
      });
      if (attempt < maxAttempts) {
        await sleep(250 * attempt * attempt);
        continue;
      }
      return { ok: false as const, status: 502, error: "openai_fetch_error" };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn("[seo] openai.request_failed", {
        model: modelLabel,
        status: res.status,
        body: bodyText.slice(0, 220),
      });

      const retryable =
        res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (retryable && attempt < maxAttempts) {
        await sleep(250 * attempt * attempt);
        continue;
      }

      return {
        ok: false as const,
        status: res.status,
        error: bodyText || `http_${res.status}`,
      };
    }

    let parsedOk = true;
    const data = (await res.json().catch(() => {
      parsedOk = false;
      return {};
    })) as OpenAIResponsesData;
    if (!parsedOk) {
      console.warn("[seo] openai.invalid_json", { model: modelLabel, attempt });
      if (attempt < maxAttempts) {
        await sleep(250 * attempt * attempt);
        continue;
      }
      return { ok: false as const, status: 502, error: "openai_invalid_json" };
    }

    const text = extractOpenAIResponseText(data);
    if (!text) {
      const hasOutput = Array.isArray(data.output) ? data.output.length : 0;
      const firstOutput = firstArrayItem(data.output);
      const firstContent =
        isRecord(firstOutput) && Array.isArray(firstOutput["content"])
          ? firstOutput["content"]
          : [];
      const contentTypes = firstContent
        .map((chunk) =>
          isRecord(chunk) && typeof chunk["type"] === "string"
            ? chunk["type"]
            : typeof chunk,
        )
        .slice(0, 6);
      console.warn("[seo] openai.empty_output", {
        model: modelLabel,
        hasOutput,
        contentTypes,
        attempt,
      });
      if (attempt < maxAttempts) {
        await sleep(250 * attempt * attempt);
        continue;
      }
      return { ok: false as const, status: 502, error: "openai_empty" };
    }
    return { ok: true as const, text };
  }

  return { ok: false as const, status: 502, error: "openai_retry_exhausted" };
}

function getOpenAIConfig(): { apiKey: string; brainModel: string } | null {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const configured = process.env["OPENAI_MODEL"];
  const brainModel =
    configured && configured.trim().length
      ? configured.trim()
      : DEFAULT_BRAIN_MODEL;
  return { apiKey, brainModel };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function includesBannedGeo(text: string): boolean {
  const lower = text.toLowerCase();
  const banned = [
    "gwinnett",
    "dekalb",
    "clayton",
    "henry",
    "rockdale",
    "douglas",
    "paulding",
    "hall",
    "walton",
  ];
  return banned.some((word) => lower.includes(word));
}

const FORBIDDEN_PUBLIC_SERVICE_PATTERN =
  /\b(yard|lawn|brush|branch|branches|leaf|leaves|green[-\s]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\b/i;

function includesForbiddenPublicServiceTerms(text: string): boolean {
  return FORBIDDEN_PUBLIC_SERVICE_PATTERN.test(text);
}

function topicHasForbiddenPublicServiceTerms(topic: SeoTopic): boolean {
  return includesForbiddenPublicServiceTerms(
    [
      topic.key,
      topic.titleHint,
      topic.primaryKeyword,
      ...topic.relatedServiceSlugs,
    ].join(" "),
  );
}

function briefHasForbiddenPublicServiceTerms(brief: PostBrief): boolean {
  return includesForbiddenPublicServiceTerms(
    [brief.title, brief.metaDescription, brief.excerpt, ...brief.outline].join(
      " ",
    ),
  );
}

function hasDollarAmounts(text: string): boolean {
  return /\$\s*\d/.test(text);
}

const BRIEF_LIMITS = {
  title: { minimum: 10, maximum: 90 },
  metaDescription: { minimum: 50, maximum: 170 },
  excerpt: { minimum: 40, maximum: 240 },
  outline: {
    minimumItems: 4,
    maximumItems: 10,
    itemMinimum: 3,
    itemMaximum: 80,
  },
} as const;

const BriefSchema = z.object({
  title: z
    .string()
    .min(BRIEF_LIMITS.title.minimum)
    .max(BRIEF_LIMITS.title.maximum),
  metaDescription: z
    .string()
    .min(BRIEF_LIMITS.metaDescription.minimum)
    .max(BRIEF_LIMITS.metaDescription.maximum),
  excerpt: z
    .string()
    .min(BRIEF_LIMITS.excerpt.minimum)
    .max(BRIEF_LIMITS.excerpt.maximum),
  outline: z
    .array(
      z
        .string()
        .min(BRIEF_LIMITS.outline.itemMinimum)
        .max(BRIEF_LIMITS.outline.itemMaximum),
    )
    .min(BRIEF_LIMITS.outline.minimumItems)
    .max(BRIEF_LIMITS.outline.maximumItems),
});

type PostBrief = z.infer<typeof BriefSchema>;
type BriefGenResult =
  | { ok: true; brief: PostBrief; modelUsed: string }
  | { ok: false; error: string; modelUsed: string };

function summarizeOpenAiError(error: string): string {
  const compact = String(error ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "unknown";
  return compact.slice(0, 180);
}

function getCodeVersion(): string | null {
  const commit =
    process.env["RENDER_GIT_COMMIT"] ??
    process.env["RENDER_COMMIT"] ??
    process.env["GIT_COMMIT"] ??
    process.env["COMMIT_SHA"] ??
    null;
  if (!commit) return null;
  const trimmed = commit.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 12);
}

function buildInternalLinks(
  topic: SeoTopic,
): Array<{ label: string; url: string }> {
  let cityAreaLink: { label: string; url: string } | null = null;
  if (
    typeof topic.key === "string" &&
    topic.key.startsWith("junk-removal-") &&
    topic.key.endsWith("-ga")
  ) {
    const cityKey = topic.key.replace(/^junk-removal-/, "").replace(/-ga$/, "");
    const match = AREA_SLUGS_BY_TOPIC_CITY_KEY[cityKey];
    if (match) {
      cityAreaLink = {
        label: `Junk removal in ${match.city}, ${SERVICE_STATE}`,
        url: `/areas/${match.slug}`,
      };
    }
  }

  const links: Array<{ label: string; url: string }> = [
    { label: "Book online", url: "/book" },
    { label: "Pricing", url: "/pricing" },
    { label: "Services", url: "/services" },
    { label: "Service areas", url: "/areas" },
  ];

  if (cityAreaLink) {
    links.push(cityAreaLink);
  } else {
    const anchorCity = pickAnchorCity(topic.key);
    const anchorSlug = AREA_SLUGS_BY_TOPIC_CITY_KEY[anchorCity.toLowerCase()];
    if (anchorSlug) {
      links.push({
        label: `Junk removal in ${anchorSlug.city}, ${SERVICE_STATE}`,
        url: `/areas/${anchorSlug.slug}`,
      });
    }
  }

  const serviceLabels: Record<string, string> = {
    furniture: "Furniture removal",
    appliances: "Appliance removal",
    "construction-debris": "Construction debris removal",
    "hot-tub": "Hot tub removal",
    "single-item": "Rubbish removal",
  };

  for (const slug of topic.relatedServiceSlugs) {
    links.push({
      label: serviceLabels[slug] ?? "Service",
      url: `/services/${slug}`,
    });
  }

  return links;
}

async function generateBrief(
  topic: SeoTopic,
  apiKey: string,
  brainModel: string,
): Promise<BriefGenResult> {
  const cityLine = SERVICE_CITIES.map(
    (city) => `${city}, ${SERVICE_STATE}`,
  ).join("; ");
  const anchorCity = pickAnchorCity(topic.key);
  const systemPrompt =
    `You are an SEO content strategist for Stonegate Junk Removal (serving ${PRIMARY_SERVICE_CITIES.join(", ")}, ${SERVICE_STATE}).
  Hard rules:
  - Do NOT include any dollar amounts.
  - Do NOT mention any counties outside Cobb, Cherokee, Fulton, and Bartow.
  - Keep the content geographically relevant to our core service cities: ${cityLine}.
  - Prefer using ${anchorCity}, ${SERVICE_STATE} as the primary city reference and optionally mention 1-2 other core cities naturally.
  - Avoid repeating the exact phrase "North Metro Atlanta" more than once (use city names instead).
  - Do NOT invent statistics, rankings, awards, or partnerships.
  - Keep it practical and specific to junk removal.
  Return ONLY JSON with: title, metaDescription, excerpt, outline (array of section headings).
  metaDescription must be <= 155 characters when possible.`.trim();

  const payload = {
    model: brainModel,
    input: [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: JSON.stringify({
          topicKey: topic.key,
          titleHint: topic.titleHint,
          primaryKeyword: topic.primaryKeyword,
          relatedServices: topic.relatedServiceSlugs,
        }),
      },
    ],
    text: {
      format: {
        type: "json_schema" as const,
        name: "blog_brief",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              minLength: BRIEF_LIMITS.title.minimum,
              maxLength: BRIEF_LIMITS.title.maximum,
            },
            metaDescription: {
              type: "string",
              minLength: BRIEF_LIMITS.metaDescription.minimum,
              maxLength: BRIEF_LIMITS.metaDescription.maximum,
            },
            excerpt: {
              type: "string",
              minLength: BRIEF_LIMITS.excerpt.minimum,
              maxLength: BRIEF_LIMITS.excerpt.maximum,
            },
            outline: {
              type: "array",
              minItems: BRIEF_LIMITS.outline.minimumItems,
              maxItems: BRIEF_LIMITS.outline.maximumItems,
              items: {
                type: "string",
                minLength: BRIEF_LIMITS.outline.itemMinimum,
                maxLength: BRIEF_LIMITS.outline.itemMaximum,
              },
            },
          },
          required: ["title", "metaDescription", "excerpt", "outline"],
        },
      },
    },
    max_output_tokens: 280,
  };

  const tryOnce = async (model: string) => {
    const res = await fetchOpenAIText(apiKey, { ...payload, model }, model);
    return { res, model };
  };

  let attempt = await tryOnce(brainModel);
  if (!attempt.res.ok && attempt.res.status === 502) {
    const fallback = BRIEF_FALLBACK_MODEL;
    if (fallback !== brainModel) {
      attempt = await tryOnce(fallback);
    }
  }

  if (!attempt.res.ok) {
    return {
      ok: false,
      modelUsed: attempt.model,
      error: `openai_${attempt.res.status}:${summarizeOpenAiError(attempt.res.error)}`,
    };
  }

  try {
    const parsed = BriefSchema.safeParse(JSON.parse(attempt.res.text));
    if (!parsed.success) {
      console.warn("[seo] brief.parse_failed", parsed.error.issues);
      return {
        ok: false,
        modelUsed: attempt.model,
        error: "schema_parse_failed",
      };
    }
    return { ok: true, modelUsed: attempt.model, brief: parsed.data };
  } catch (error) {
    console.warn("[seo] brief.json_failed", String(error));
    return { ok: false, modelUsed: attempt.model, error: "json_parse_failed" };
  }
}

async function writePostMarkdown(
  topic: SeoTopic,
  brief: PostBrief,
  apiKey: string,
  company: { businessName: string; primaryPhone: string },
): Promise<string | null> {
  const internalLinks = buildInternalLinks(topic);
  const anchorCity = pickAnchorCity(topic.key);
  const primaryCitySentence = `We primarily serve ${PRIMARY_SERVICE_CITIES.join(", ")}, ${SERVICE_STATE}.`;

  const systemPrompt =
    `You write a helpful local SEO blog post in Markdown for ${company.businessName}.
  Rules:
  - Output Markdown ONLY.
  - Do NOT include any dollar amounts.
  - Do NOT mention any counties outside Cobb, Cherokee, Fulton, and Bartow.
  - Do NOT invent statistics, legal claims, rankings, or awards.
  - Mention "${company.businessName}" in the intro.
  - Include this service-area sentence (once, naturally): "${primaryCitySentence}"
  - Use ${anchorCity}, ${SERVICE_STATE} as the primary local reference and mention 1-2 other core cities naturally (do not keyword-stuff).
  - Avoid repeating the exact phrase "North Metro Atlanta" more than once (use city names instead).
  - Include a short FAQ section (4 Q&As).
  - Include internal links exactly as provided (use [label](url)).
  - End with a short CTA to book online or call ${company.primaryPhone}.`.trim();

  const payload = {
    model: VOICE_MODEL,
    input: [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: JSON.stringify({
          title: brief.title,
          excerpt: brief.excerpt,
          outline: brief.outline,
          primaryKeyword: topic.primaryKeyword,
          serviceArea: `${PRIMARY_SERVICE_CITIES.join(", ")}, ${SERVICE_STATE} (Cobb, Cherokee, Fulton, and Bartow)`,
          internalLinks,
        }),
      },
    ],
    text: { verbosity: "medium" as const },
    max_output_tokens: 1400,
  };

  const res = await fetchOpenAIText(apiKey, payload, VOICE_MODEL);
  if (!res.ok) return null;
  const text = res.text.trim();
  if (!text) return null;
  return text;
}

async function pickNextTopic(
  db: SeoDbExecutor,
): Promise<{ topic: SeoTopic; nextCursor: number }> {
  const cursorKey = "blog_topic_cursor";
  const [stateRow] = await db
    .select({ value: seoAgentState.value })
    .from(seoAgentState)
    .where(eq(seoAgentState.key, cursorKey))
    .limit(1);

  const currentCursorRaw = isRecord(stateRow?.value)
    ? stateRow.value["idx"]
    : null;
  const currentCursor = Number.isFinite(Number(currentCursorRaw))
    ? Math.max(0, Number(currentCursorRaw))
    : 0;

  const ninetyDays = daysAgo(90);
  const usedRows = await db
    .select({ topicKey: blogPosts.topicKey })
    .from(blogPosts)
    .where(
      and(isNotNull(blogPosts.topicKey), gte(blogPosts.createdAt, ninetyDays)),
    );

  const used = new Set(
    usedRows.map((r) => (r.topicKey ?? "").trim()).filter(Boolean),
  );
  const total = SEO_TOPICS.length;
  const start = total ? currentCursor % total : 0;

  let chosenIdx = start;
  for (let offset = 0; offset < total; offset += 1) {
    const idx = (start + offset) % total;
    const candidate = SEO_TOPICS[idx];
    if (!candidate) continue;
    if (!used.has(candidate.key)) {
      chosenIdx = idx;
      break;
    }
  }

  const nextCursor = total ? (chosenIdx + 1) % total : 0;
  return { topic: SEO_TOPICS[chosenIdx] ?? SEO_TOPICS[0]!, nextCursor };
}

async function persistCursor(db: SeoDbExecutor, nextCursor: number) {
  const key = "blog_topic_cursor";
  await db
    .insert(seoAgentState)
    .values({ key, value: { idx: nextCursor }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: seoAgentState.key,
      set: { value: { idx: nextCursor }, updatedAt: new Date() },
    });
}

async function tryPersistAutopublishLastRun(
  db: SeoDbExecutor,
  payload: {
    attemptedAt: Date;
    invokedBy: string;
    disabled: boolean;
    openaiConfigured: boolean;
    brainModel: string | null;
    brainModelUsed?: string | null;
    voiceModel: string;
    result: SeoDraftResult;
  },
) {
  const value = {
    attemptedAt: payload.attemptedAt.toISOString(),
    invokedBy: payload.invokedBy,
    codeVersion: getCodeVersion(),
    disabled: payload.disabled,
    openaiConfigured: payload.openaiConfigured,
    brainModel: payload.brainModel,
    brainModelUsed: payload.brainModelUsed ?? payload.brainModel ?? null,
    voiceModel: payload.voiceModel,
    result: payload.result,
  };

  try {
    await db
      .insert(seoAgentState)
      .values({ key: AUTOPUBLISH_LAST_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: seoAgentState.key,
        set: { value, updatedAt: new Date() },
      });
  } catch {
    // ignore
  }
}

async function ensureUniqueSlug(
  db: SeoDbExecutor,
  baseSlug: string,
): Promise<string> {
  const normalized = baseSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const base = normalized.length ? normalized : "post";

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await db
      .select({ slug: blogPosts.slug })
      .from(blogPosts)
      .where(eq(blogPosts.slug, candidate))
      .limit(1);
    if (!existing.length) return candidate;
  }

  return `${base}-${Date.now()}`;
}

export type SeoDraftResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped: false;
      postId: string;
      slug: string;
      title: string;
      editorialStatus: "draft" | "review" | "published" | "failed";
      auditEventId: string;
      committedAt: string;
    }
  | { ok: false; error: string };

export async function maybeGenerateSeoDraft({
  force,
  invokedBy,
  generationKeyHash,
  mutation,
}: {
  force?: boolean;
  invokedBy?: string;
  generationKeyHash?: string | null;
  mutation?: TeamMutationContext | null;
} = {}): Promise<SeoDraftResult> {
  const attemptedAt = new Date();
  const invoker =
    invokedBy && invokedBy.trim().length ? invokedBy.trim() : "unknown";
  const disabled = process.env["SEO_AUTOPUBLISH_DISABLED"] === "1";

  if (disabled) {
    const result: SeoDraftResult = {
      ok: true,
      skipped: true,
      reason: "disabled",
    };
    try {
      const db = getDb();
      await tryPersistAutopublishLastRun(db, {
        attemptedAt,
        invokedBy: invoker,
        disabled: true,
        openaiConfigured: Boolean(process.env["OPENAI_API_KEY"]),
        brainModel: process.env["OPENAI_MODEL"]?.trim() || DEFAULT_BRAIN_MODEL,
        voiceModel: VOICE_MODEL,
        result,
      });
    } catch {
      // ignore
    }
    return result;
  }

  const config = getOpenAIConfig();
  if (!config) {
    const result: SeoDraftResult = {
      ok: true,
      skipped: true,
      reason: "openai_not_configured",
    };
    try {
      const db = getDb();
      await tryPersistAutopublishLastRun(db, {
        attemptedAt,
        invokedBy: invoker,
        disabled: false,
        openaiConfigured: false,
        brainModel: null,
        voiceModel: VOICE_MODEL,
        result,
      });
    } catch {
      // ignore
    }
    return result;
  }

  const db = getDb();
  let brainModelUsed: string | null = config.brainModel;
  const persist = (result: SeoDraftResult) =>
    tryPersistAutopublishLastRun(db, {
      attemptedAt,
      invokedBy: invoker,
      disabled: false,
      openaiConfigured: true,
      brainModel: config.brainModel,
      brainModelUsed,
      voiceModel: VOICE_MODEL,
      result,
    });

  const lockKey = 88314291;

  try {
    const result = await db.transaction(async (tx) => {
      const lockResult: unknown = await tx.execute(
        sql`select pg_try_advisory_xact_lock(${lockKey}) as locked`,
      );
      const firstLockRow = firstArrayItem(lockResult);
      const locked = isRecord(firstLockRow) && firstLockRow["locked"] === true;
      if (!locked) {
        return {
          ok: true,
          skipped: true,
          reason: "locked",
        } satisfies SeoDraftResult;
      }

      const now = new Date();

      if (generationKeyHash) {
        const [existingDraft] = await tx
          .select({
            id: blogPosts.id,
            slug: blogPosts.slug,
            title: blogPosts.title,
            editorialStatus: blogPosts.editorialStatus,
          })
          .from(blogPosts)
          .where(eq(blogPosts.generationKeyHash, generationKeyHash))
          .limit(1);
        if (existingDraft) {
          const [existingAudit] = await tx
            .select({ id: auditLogs.id, createdAt: auditLogs.createdAt })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.action, "seo.draft.generated"),
                eq(auditLogs.entityId, existingDraft.id),
                eq(auditLogs.idempotencyKeyHash, generationKeyHash),
              ),
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(1);
          if (!existingAudit) {
            throw new Error("draft_audit_missing");
          }
          const editorialStatus =
            existingDraft.editorialStatus === "review" ||
            existingDraft.editorialStatus === "published" ||
            existingDraft.editorialStatus === "failed"
              ? existingDraft.editorialStatus
              : "draft";
          return {
            ok: true,
            skipped: false,
            postId: existingDraft.id,
            slug: existingDraft.slug,
            title: existingDraft.title,
            editorialStatus,
            auditEventId: existingAudit.id,
            committedAt: existingAudit.createdAt.toISOString(),
          } satisfies SeoDraftResult;
        }
      }

      if (!force) {
        const since = daysAgo(7);
        const countRow = await tx
          .select({ cnt: sql<number>`count(*)` })
          .from(blogPosts)
          .where(gte(blogPosts.createdAt, since))
          .then((rows) => rows[0]);
        const count = Number(countRow?.cnt ?? 0);
        if (count >= 2) {
          return {
            ok: true,
            skipped: true,
            reason: "quota_met",
          } satisfies SeoDraftResult;
        }

        const latest = await tx
          .select({ createdAt: blogPosts.createdAt })
          .from(blogPosts)
          .where(lte(blogPosts.createdAt, now))
          .orderBy(desc(blogPosts.createdAt))
          .limit(1);
        const lastGeneratedAt = latest[0]?.createdAt ?? null;
        if (
          lastGeneratedAt &&
          lastGeneratedAt.getTime() > daysAgo(3).getTime()
        ) {
          return {
            ok: true,
            skipped: true,
            reason: "too_soon",
          } satisfies SeoDraftResult;
        }
      }

      const { topic, nextCursor } = await pickNextTopic(tx);
      if (topicHasForbiddenPublicServiceTerms(topic)) {
        await persistCursor(tx, nextCursor);
        return {
          ok: true,
          skipped: true,
          reason: "forbidden_topic",
        } satisfies SeoDraftResult;
      }
      const companyProfile = await getCompanyProfilePolicy(tx);
      const briefRes = await generateBrief(
        topic,
        config.apiKey,
        config.brainModel,
      );
      if (!briefRes.ok) {
        brainModelUsed = briefRes.modelUsed;
        return {
          ok: false,
          error: `brief_generation_failed:${briefRes.error}`,
        } satisfies SeoDraftResult;
      }
      const brief = briefRes.brief;
      brainModelUsed = briefRes.modelUsed;
      if (briefHasForbiddenPublicServiceTerms(brief)) {
        await persistCursor(tx, nextCursor);
        return {
          ok: true,
          skipped: true,
          reason: "forbidden_brief",
        } satisfies SeoDraftResult;
      }

      const slug = await ensureUniqueSlug(tx, topic.key);

      let markdown: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const drafted = await writePostMarkdown(topic, brief, config.apiKey, {
          businessName: companyProfile.businessName,
          primaryPhone: companyProfile.primaryPhone,
        });
        if (!drafted) continue;
        if (hasDollarAmounts(drafted)) continue;
        if (includesBannedGeo(drafted)) continue;
        if (includesForbiddenPublicServiceTerms(drafted)) continue;
        markdown = drafted;
        break;
      }

      if (!markdown) {
        return {
          ok: false,
          error: "post_generation_failed",
        } satisfies SeoDraftResult;
      }

      const title = brief.title.trim();
      const metaTitle = title.length <= 70 ? title : title.slice(0, 70).trim();
      const metaDescription = brief.metaDescription.trim().slice(0, 170);
      const excerpt = brief.excerpt.trim().slice(0, 240);

      const generatedAt = new Date();
      const [inserted] = await tx
        .insert(blogPosts)
        .values({
          slug,
          title,
          excerpt,
          contentMarkdown: markdown,
          metaTitle,
          metaDescription,
          topicKey: topic.key,
          editorialStatus: "draft",
          version: 1,
          generatedAt,
          generationKeyHash: generationKeyHash ?? null,
          publishedAt: null,
          createdAt: generatedAt,
          updatedAt: generatedAt,
        })
        .returning({
          id: blogPosts.id,
          slug: blogPosts.slug,
          title: blogPosts.title,
        });

      if (!inserted) {
        return { ok: false, error: "insert_failed" } satisfies SeoDraftResult;
      }

      await persistCursor(tx, nextCursor);

      const audit = mutation
        ? await mutation.audit.insertSuccess(tx, {
            entityType: "blog_post",
            entityId: inserted.id,
            before: null,
            after: {
              editorialStatus: "draft",
              version: 1,
              slug: inserted.slug,
            },
            metadata: {
              invokedBy: invoker,
              publicationEffect: "none",
            },
            committedAt: generatedAt,
          })
        : await (async () => {
            const auditEventId = randomUUID();
            await tx.insert(auditLogs).values({
              id: auditEventId,
              actorType: "worker",
              actorId: null,
              actorRole: null,
              actorLabel: invoker,
              sessionId: null,
              authMethod: "service",
              requiredPermissions: ["marketing.publish"],
              outcome: "succeeded",
              surface: "seo_agent",
              action: "seo.draft.generated",
              entityType: "blog_post",
              entityId: inserted.id,
              meta: {
                invokedBy: invoker,
                publicationEffect: "none",
                editorialStatus: "draft",
                version: 1,
              },
              createdAt: generatedAt,
            });
            return {
              auditEventId,
              committedAt: generatedAt.toISOString(),
            };
          })();

      return {
        ok: true,
        skipped: false,
        postId: inserted.id,
        slug: inserted.slug,
        title: inserted.title,
        editorialStatus: "draft",
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
      } satisfies SeoDraftResult;
    });

    await persist(result);
    return result;
  } catch (error) {
    console.error("[seo] draft_generation_failed", error);
    const result: SeoDraftResult = { ok: false, error: "server_error" };
    await persist(result);
    return result;
  }
}

/**
 * Compatibility alias for callers deployed before the editorial review gate.
 * Despite the historical name, this function can only create a private draft.
 */
export const maybeAutopublishBlogPost = maybeGenerateSeoDraft;
