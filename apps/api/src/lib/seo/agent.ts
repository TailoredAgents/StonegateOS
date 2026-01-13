import { z } from "zod";
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { blogPosts, getDb, seoAgentState } from "@/db";
import { SEO_TOPICS, type SeoTopic } from "./topics";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_BRAIN_MODEL = "gpt-5-mini";
const VOICE_MODEL = "gpt-4.1-mini";
const AUTOPUBLISH_LAST_KEY = "blog_autopublish_last";

type OpenAIResponsesData = {
  output?: Array<{ content?: Array<{ text?: unknown; type?: unknown }> }>;
  output_text?: unknown;
};

function extractOpenAIResponseText(data: OpenAIResponsesData): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const outputItems = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of outputItems) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (!chunk) continue;
      const text = (chunk as any)?.text;
      const value = typeof text === "string" ? text : typeof text?.value === "string" ? text.value : null;
      if (value && value.trim()) parts.push(value.trim());
    }
  }
  return parts.join("\n").trim();
}

async function fetchOpenAIText(apiKey: string, payload: Record<string, unknown>, modelLabel: string) {
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.warn("[seo] openai.request_failed", { model: modelLabel, status: res.status, body: bodyText.slice(0, 220) });
    return { ok: false as const, status: res.status, error: bodyText };
  }

  const data = (await res.json().catch(() => ({}))) as OpenAIResponsesData;
  const text = extractOpenAIResponseText(data);
  if (!text) {
    return { ok: false as const, status: 502, error: "openai_empty" };
  }
  return { ok: true as const, text };
}

function getOpenAIConfig(): { apiKey: string; brainModel: string } | null {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const configured = process.env["OPENAI_MODEL"];
  const brainModel = configured && configured.trim().length ? configured.trim() : DEFAULT_BRAIN_MODEL;
  return { apiKey, brainModel };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function includesBannedGeo(text: string): boolean {
  const lower = text.toLowerCase();
  const banned = ["gwinnett", "dekalb", "clayton", "henry", "rockdale", "douglas", "paulding", "hall", "walton"];
  return banned.some((word) => lower.includes(word));
}

function hasDollarAmounts(text: string): boolean {
  return /\$\s*\d/.test(text);
}

const BriefSchema = z.object({
  title: z.string().min(10).max(90),
  metaDescription: z.string().min(50).max(170),
  excerpt: z.string().min(40).max(240),
  outline: z.array(z.string().min(3).max(80)).min(4).max(10)
});

type PostBrief = z.infer<typeof BriefSchema>;
type BriefGenResult = { ok: true; brief: PostBrief } | { ok: false; error: string };

function buildInternalLinks(topic: SeoTopic): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [
    { label: "Pricing", url: "/pricing" },
    { label: "Services", url: "/services" },
    { label: "Service areas", url: "/areas" },
    { label: "Schedule an estimate", url: "/estimate" }
  ];

  const serviceLabels: Record<string, string> = {
    furniture: "Furniture removal",
    appliances: "Appliance removal",
    "yard-waste": "Yard waste removal",
    "construction-debris": "Construction debris removal",
    "hot-tub": "Hot tub removal",
    "single-item": "Rubbish removal"
  };

  for (const slug of topic.relatedServiceSlugs) {
    links.push({ label: serviceLabels[slug] ?? "Service", url: `/services/${slug}` });
  }

  return links;
}

async function generateBrief(topic: SeoTopic, apiKey: string, brainModel: string): Promise<BriefGenResult> {
  const systemPrompt = `You are an SEO content strategist for Stonegate Junk Removal (North Metro Atlanta).
Hard rules:
- Do NOT include any dollar amounts.
- Do NOT mention any counties outside Cobb, Cherokee, Fulton, and Bartow.
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
          relatedServices: topic.relatedServiceSlugs
        })
      }
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
            title: { type: "string" },
            metaDescription: { type: "string" },
            excerpt: { type: "string" },
            outline: { type: "array", items: { type: "string" } }
          },
          required: ["title", "metaDescription", "excerpt", "outline"]
        }
      }
    },
    max_output_tokens: 280
  };

  const res = await fetchOpenAIText(apiKey, payload, brainModel);
  if (!res.ok) return { ok: false, error: `openai_${res.status}` };

  try {
    const parsed = BriefSchema.safeParse(JSON.parse(res.text));
    if (!parsed.success) {
      console.warn("[seo] brief.parse_failed", parsed.error.issues);
      return { ok: false, error: "schema_parse_failed" };
    }
    return { ok: true, brief: parsed.data };
  } catch (error) {
    console.warn("[seo] brief.json_failed", String(error));
    return { ok: false, error: "json_parse_failed" };
  }
}

async function writePostMarkdown(
  topic: SeoTopic,
  brief: PostBrief,
  apiKey: string
): Promise<string | null> {
  const internalLinks = buildInternalLinks(topic);

  const systemPrompt = `You write a helpful local SEO blog post in Markdown for Stonegate Junk Removal.
Rules:
- Output Markdown ONLY.
- Do NOT include any dollar amounts.
- Do NOT mention any counties outside Cobb, Cherokee, Fulton, and Bartow.
- Do NOT invent statistics, legal claims, rankings, or awards.
- Mention "Stonegate Junk Removal" in the intro.
- Include a short FAQ section (4 Q&As).
- Include internal links exactly as provided (use [label](url)).
- End with a short CTA to schedule an estimate or call (404) 777-2631.`.trim();

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
          serviceArea: "Cobb, Cherokee, Fulton, and Bartow counties (North Metro Atlanta)",
          internalLinks
        })
      }
    ],
    text: { verbosity: "medium" as const },
    max_output_tokens: 1400
  };

  const res = await fetchOpenAIText(apiKey, payload, VOICE_MODEL);
  if (!res.ok) return null;
  const text = res.text.trim();
  if (!text) return null;
  return text;
}

async function pickNextTopic(db: ReturnType<typeof getDb>): Promise<{ topic: SeoTopic; nextCursor: number }> {
  const cursorKey = "blog_topic_cursor";
  const [stateRow] = await db
    .select({ value: seoAgentState.value })
    .from(seoAgentState)
    .where(eq(seoAgentState.key, cursorKey))
    .limit(1);

  const currentCursorRaw = stateRow?.value && typeof stateRow.value === "object" ? (stateRow.value as any)["idx"] : null;
  const currentCursor = Number.isFinite(Number(currentCursorRaw)) ? Math.max(0, Number(currentCursorRaw)) : 0;

  const ninetyDays = daysAgo(90);
  const usedRows = await db
    .select({ topicKey: blogPosts.topicKey })
    .from(blogPosts)
    .where(and(isNotNull(blogPosts.topicKey), isNotNull(blogPosts.publishedAt), gte(blogPosts.publishedAt, ninetyDays)));

  const used = new Set(usedRows.map((r) => (r.topicKey ?? "").trim()).filter(Boolean));
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

async function persistCursor(db: ReturnType<typeof getDb>, nextCursor: number) {
  const key = "blog_topic_cursor";
  await db
    .insert(seoAgentState)
    .values({ key, value: { idx: nextCursor }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: seoAgentState.key,
      set: { value: { idx: nextCursor }, updatedAt: new Date() }
    });
}

async function tryPersistAutopublishLastRun(
  db: ReturnType<typeof getDb>,
  payload: {
    attemptedAt: Date;
    invokedBy: string;
    disabled: boolean;
    openaiConfigured: boolean;
    brainModel: string | null;
    voiceModel: string;
    result: SeoPublishResult;
  }
) {
  const value = {
    attemptedAt: payload.attemptedAt.toISOString(),
    invokedBy: payload.invokedBy,
    disabled: payload.disabled,
    openaiConfigured: payload.openaiConfigured,
    brainModel: payload.brainModel,
    voiceModel: payload.voiceModel,
    result: payload.result
  };

  try {
    await db
      .insert(seoAgentState)
      .values({ key: AUTOPUBLISH_LAST_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: seoAgentState.key,
        set: { value, updatedAt: new Date() }
      });
  } catch {
    // ignore
  }
}

async function ensureUniqueSlug(db: ReturnType<typeof getDb>, baseSlug: string): Promise<string> {
  const normalized = baseSlug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
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

export type SeoPublishResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; postId: string; slug: string; title: string }
  | { ok: false; error: string };

export async function maybeAutopublishBlogPost(
  { force, invokedBy }: { force?: boolean; invokedBy?: string } = {}
): Promise<SeoPublishResult> {
  const attemptedAt = new Date();
  const invoker = invokedBy && invokedBy.trim().length ? invokedBy.trim() : "unknown";
  const disabled = process.env["SEO_AUTOPUBLISH_DISABLED"] === "1";

  if (disabled) {
    const result: SeoPublishResult = { ok: true, skipped: true, reason: "disabled" };
    try {
      const db = getDb();
      await tryPersistAutopublishLastRun(db, {
        attemptedAt,
        invokedBy: invoker,
        disabled: true,
        openaiConfigured: Boolean(process.env["OPENAI_API_KEY"]),
        brainModel: process.env["OPENAI_MODEL"]?.trim() ? process.env["OPENAI_MODEL"]!.trim() : DEFAULT_BRAIN_MODEL,
        voiceModel: VOICE_MODEL,
        result
      });
    } catch {
      // ignore
    }
    return result;
  }

  const config = getOpenAIConfig();
  if (!config) {
    const result: SeoPublishResult = { ok: true, skipped: true, reason: "openai_not_configured" };
    try {
      const db = getDb();
      await tryPersistAutopublishLastRun(db, {
        attemptedAt,
        invokedBy: invoker,
        disabled: false,
        openaiConfigured: false,
        brainModel: null,
        voiceModel: VOICE_MODEL,
        result
      });
    } catch {
      // ignore
    }
    return result;
  }

  const db = getDb();
  const persist = (result: SeoPublishResult) =>
    tryPersistAutopublishLastRun(db, {
      attemptedAt,
      invokedBy: invoker,
      disabled: false,
      openaiConfigured: true,
      brainModel: config.brainModel,
      voiceModel: VOICE_MODEL,
      result
    });

  const lockKey = 88314291;
  const lockRow = await db.execute(sql`select pg_try_advisory_lock(${lockKey}) as locked`);
  const locked = Array.isArray(lockRow) ? Boolean((lockRow[0] as any)?.locked) : false;
  if (!locked) {
    const result: SeoPublishResult = { ok: true, skipped: true, reason: "locked" };
    await persist(result);
    return result;
  }

  try {
    const now = new Date();

    if (!force) {
      const since = daysAgo(7);
      const countRow = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(blogPosts)
        .where(and(isNotNull(blogPosts.publishedAt), gte(blogPosts.publishedAt, since)))
        .then((rows) => rows[0]);
      const count = Number(countRow?.cnt ?? 0);
      if (count >= 2) {
        const result: SeoPublishResult = { ok: true, skipped: true, reason: "quota_met" };
        await persist(result);
        return result;
      }

      const latest = await db
        .select({ publishedAt: blogPosts.publishedAt })
        .from(blogPosts)
        .where(and(isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now)))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(1);
      const lastPublishedAt = latest[0]?.publishedAt ?? null;
      if (lastPublishedAt && lastPublishedAt.getTime() > daysAgo(3).getTime()) {
        const result: SeoPublishResult = { ok: true, skipped: true, reason: "too_soon" };
        await persist(result);
        return result;
      }
    }

    const { topic, nextCursor } = await pickNextTopic(db);
    const briefRes = await generateBrief(topic, config.apiKey, config.brainModel);
    if (!briefRes.ok) {
      const result: SeoPublishResult = { ok: false, error: `brief_generation_failed:${briefRes.error}` };
      await persist(result);
      return result;
    }
    const brief = briefRes.brief;

    const slug = await ensureUniqueSlug(db, topic.key);

    let markdown: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const drafted = await writePostMarkdown(topic, brief, config.apiKey);
      if (!drafted) continue;
      if (hasDollarAmounts(drafted)) continue;
      if (includesBannedGeo(drafted)) continue;
      markdown = drafted;
      break;
    }

    if (!markdown) {
      const result: SeoPublishResult = { ok: false, error: "post_generation_failed" };
      await persist(result);
      return result;
    }

    const title = brief.title.trim();
    const metaTitle = title.length <= 70 ? title : title.slice(0, 70).trim();
    const metaDescription = brief.metaDescription.trim().slice(0, 170);
    const excerpt = brief.excerpt.trim().slice(0, 240);

    const publishedAt = new Date();
    const [inserted] = await db
      .insert(blogPosts)
      .values({
        slug,
        title,
        excerpt,
        contentMarkdown: markdown,
        metaTitle,
        metaDescription,
        topicKey: topic.key,
        publishedAt,
        createdAt: publishedAt,
        updatedAt: publishedAt
      })
      .returning({ id: blogPosts.id, slug: blogPosts.slug, title: blogPosts.title });

    if (!inserted) {
      const result: SeoPublishResult = { ok: false, error: "insert_failed" };
      await persist(result);
      return result;
    }

    await persistCursor(db, nextCursor);

    const result: SeoPublishResult = { ok: true, skipped: false, postId: inserted.id, slug: inserted.slug, title: inserted.title };
    await persist(result);
    return result;
  } catch (error) {
    console.error("[seo] autopublish_failed", error);
    const result: SeoPublishResult = { ok: false, error: "server_error" };
    await persist(result);
    return result;
  } finally {
    try {
      await db.execute(sql`select pg_advisory_unlock(${lockKey})`);
    } catch {
      // ignore
    }
  }
}
