import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { blogPosts, getDb, seoAgentState } from "@/db";
import { requirePermission } from "@/lib/permissions";

const AUTOPUBLISH_LAST_KEY = "blog_autopublish_last";
const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requirePermission(request, "marketing.read");
  if (denied) return denied;

  const db = getDb();
  const now = new Date();
  const since7d = new Date(now.getTime() - 7 * DAY_MS);

  const [
    lastRow,
    recentPosts,
    recentPublishedRows,
    latestPublishedRow,
    generationWindowRow,
  ] = await Promise.all([
    db
      .select({
        value: seoAgentState.value,
        updatedAt: seoAgentState.updatedAt,
      })
      .from(seoAgentState)
      .where(eq(seoAgentState.key, AUTOPUBLISH_LAST_KEY))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: blogPosts.id,
        slug: blogPosts.slug,
        title: blogPosts.title,
        excerpt: blogPosts.excerpt,
        contentMarkdown: blogPosts.contentMarkdown,
        metaTitle: blogPosts.metaTitle,
        metaDescription: blogPosts.metaDescription,
        editorialStatus: blogPosts.editorialStatus,
        version: blogPosts.version,
        generatedAt: blogPosts.generatedAt,
        reviewRequestedAt: blogPosts.reviewRequestedAt,
        reviewedAt: blogPosts.reviewedAt,
        publishedAt: blogPosts.publishedAt,
        lastError: blogPosts.lastError,
        createdAt: blogPosts.createdAt,
        updatedAt: blogPosts.updatedAt,
      })
      .from(blogPosts)
      .orderBy(desc(blogPosts.updatedAt), desc(blogPosts.id))
      .limit(20),
    db
      .select({ publishedAt: blogPosts.publishedAt })
      .from(blogPosts)
      .where(
        and(
          isNotNull(blogPosts.publishedAt),
          gte(blogPosts.publishedAt, since7d),
          lte(blogPosts.publishedAt, now),
        ),
      )
      .orderBy(desc(blogPosts.publishedAt))
      .limit(50),
    db
      .select({ publishedAt: blogPosts.publishedAt })
      .from(blogPosts)
      .where(
        and(isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now)),
      )
      .orderBy(desc(blogPosts.publishedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        count: sql<number>`count(*)`,
        oldestAt: sql<Date | null>`min(${blogPosts.createdAt})`,
        latestAt: sql<Date | null>`max(${blogPosts.createdAt})`,
      })
      .from(blogPosts)
      .where(gte(blogPosts.createdAt, since7d))
      .then((rows) => rows[0] ?? null),
  ]);

  const lastRunRaw =
    lastRow?.value &&
    typeof lastRow.value === "object" &&
    !Array.isArray(lastRow.value)
      ? lastRow.value
      : null;
  const lastAttemptAt = asDate(lastRunRaw?.["attemptedAt"]) ?? null;
  const lastResult = lastRunRaw?.["result"] ?? null;
  const invokedBy =
    typeof lastRunRaw?.["invokedBy"] === "string"
      ? lastRunRaw["invokedBy"]
      : null;
  const codeVersion =
    typeof lastRunRaw?.["codeVersion"] === "string"
      ? lastRunRaw["codeVersion"]
      : null;
  const disabled =
    typeof lastRunRaw?.["disabled"] === "boolean"
      ? lastRunRaw["disabled"]
      : null;
  const openaiConfigured =
    typeof lastRunRaw?.["openaiConfigured"] === "boolean"
      ? lastRunRaw["openaiConfigured"]
      : null;
  const brainModel =
    typeof lastRunRaw?.["brainModel"] === "string"
      ? lastRunRaw["brainModel"]
      : null;
  const brainModelUsed =
    typeof lastRunRaw?.["brainModelUsed"] === "string"
      ? lastRunRaw["brainModelUsed"]
      : null;
  const voiceModel =
    typeof lastRunRaw?.["voiceModel"] === "string"
      ? lastRunRaw["voiceModel"]
      : null;

  const published7d = recentPublishedRows
    .map((r) => r.publishedAt)
    .filter((publishedAt): publishedAt is Date => publishedAt instanceof Date);
  const publishedLast7Days = published7d.length;
  const lastPublishedAt = latestPublishedRow?.publishedAt ?? null;
  const generatedLast7Days = Number(generationWindowRow?.count ?? 0);
  const lastGeneratedAt = asDate(generationWindowRow?.latestAt);
  const oldestGeneratedAt = asDate(generationWindowRow?.oldestAt);

  let nextEligibleAt: Date | null = null;
  if (publishedLast7Days >= 2) {
    const oldest = published7d[published7d.length - 1] ?? null;
    if (oldest) nextEligibleAt = new Date(oldest.getTime() + 7 * DAY_MS);
  }
  if (
    lastPublishedAt &&
    lastPublishedAt.getTime() > now.getTime() - 3 * DAY_MS
  ) {
    nextEligibleAt = maxDate(
      nextEligibleAt,
      new Date(lastPublishedAt.getTime() + 3 * DAY_MS),
    );
  }

  let nextGenerationEligibleAt: Date | null = null;
  if (generatedLast7Days >= 2 && oldestGeneratedAt) {
    nextGenerationEligibleAt = new Date(
      oldestGeneratedAt.getTime() + 7 * DAY_MS,
    );
  }
  if (
    lastGeneratedAt &&
    lastGeneratedAt.getTime() > now.getTime() - 3 * DAY_MS
  ) {
    nextGenerationEligibleAt = maxDate(
      nextGenerationEligibleAt,
      new Date(lastGeneratedAt.getTime() + 3 * DAY_MS),
    );
  }

  const status = {
    now: now.toISOString(),
    lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
    lastResult,
    invokedBy,
    codeVersion,
    disabled,
    openaiConfigured,
    brainModel,
    brainModelUsed,
    voiceModel,
    lastPublishedAt: lastPublishedAt ? lastPublishedAt.toISOString() : null,
    publishedLast7Days,
    nextEligibleAt: nextEligibleAt ? nextEligibleAt.toISOString() : null,
    lastGeneratedAt: lastGeneratedAt ? lastGeneratedAt.toISOString() : null,
    generatedLast7Days,
    nextGenerationEligibleAt: nextGenerationEligibleAt
      ? nextGenerationEligibleAt.toISOString()
      : null,
  };

  const posts = recentPosts.map((post) => ({
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    contentMarkdown: post.contentMarkdown,
    metaTitle: post.metaTitle,
    metaDescription: post.metaDescription,
    editorialStatus:
      post.editorialStatus === "review" ||
      post.editorialStatus === "published" ||
      post.editorialStatus === "failed"
        ? post.editorialStatus
        : "draft",
    version: post.version,
    generatedAt: (post.generatedAt ?? post.createdAt).toISOString(),
    reviewRequestedAt: post.reviewRequestedAt
      ? post.reviewRequestedAt.toISOString()
      : null,
    reviewedAt: post.reviewedAt ? post.reviewedAt.toISOString() : null,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    lastError: post.lastError,
    updatedAt: post.updatedAt ? post.updatedAt.toISOString() : null,
  }));

  return NextResponse.json({ ok: true, status, posts });
}
