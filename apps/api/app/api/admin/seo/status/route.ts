import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { blogPosts, getDb, seoAgentState } from "@/db";
import { isAdminRequest } from "../../../web/admin";

const AUTOPUBLISH_LAST_KEY = "blog_autopublish_last";
const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value: unknown): Date | null {
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
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const now = new Date();
  const since7d = new Date(now.getTime() - 7 * DAY_MS);

  const [lastRow, recentPosts, recentPublishedRows] = await Promise.all([
    db
      .select({ value: seoAgentState.value, updatedAt: seoAgentState.updatedAt })
      .from(seoAgentState)
      .where(eq(seoAgentState.key, AUTOPUBLISH_LAST_KEY))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: blogPosts.id,
        slug: blogPosts.slug,
        title: blogPosts.title,
        publishedAt: blogPosts.publishedAt,
        updatedAt: blogPosts.updatedAt
      })
      .from(blogPosts)
      .where(and(isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now)))
      .orderBy(desc(blogPosts.publishedAt))
      .limit(12),
    db
      .select({ publishedAt: blogPosts.publishedAt })
      .from(blogPosts)
      .where(and(isNotNull(blogPosts.publishedAt), gte(blogPosts.publishedAt, since7d), lte(blogPosts.publishedAt, now)))
      .orderBy(desc(blogPosts.publishedAt))
      .limit(50)
  ]);

  const lastRunRaw =
    lastRow?.value && typeof lastRow.value === "object" ? (lastRow.value as Record<string, unknown>) : null;
  const lastAttemptAt = asDate(lastRunRaw?.["attemptedAt"]) ?? null;
  const lastResult = lastRunRaw?.["result"] ?? null;
  const invokedBy = typeof lastRunRaw?.["invokedBy"] === "string" ? (lastRunRaw["invokedBy"] as string) : null;
  const disabled = typeof lastRunRaw?.["disabled"] === "boolean" ? (lastRunRaw["disabled"] as boolean) : null;
  const openaiConfigured =
    typeof lastRunRaw?.["openaiConfigured"] === "boolean" ? (lastRunRaw["openaiConfigured"] as boolean) : null;
  const brainModel = typeof lastRunRaw?.["brainModel"] === "string" ? (lastRunRaw["brainModel"] as string) : null;
  const voiceModel = typeof lastRunRaw?.["voiceModel"] === "string" ? (lastRunRaw["voiceModel"] as string) : null;

  const published7d = recentPublishedRows.map((r) => r.publishedAt).filter(Boolean) as Date[];
  const publishedLast7Days = published7d.length;
  const lastPublishedAt = published7d[0] ?? null;

  let nextEligibleAt: Date | null = null;
  if (publishedLast7Days >= 2) {
    const oldest = published7d[published7d.length - 1] ?? null;
    if (oldest) nextEligibleAt = new Date(oldest.getTime() + 7 * DAY_MS);
  }
  if (lastPublishedAt && lastPublishedAt.getTime() > now.getTime() - 3 * DAY_MS) {
    nextEligibleAt = maxDate(nextEligibleAt, new Date(lastPublishedAt.getTime() + 3 * DAY_MS));
  }

  const status = {
    now: now.toISOString(),
    lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
    lastResult,
    invokedBy,
    disabled,
    openaiConfigured,
    brainModel,
    voiceModel,
    lastPublishedAt: lastPublishedAt ? lastPublishedAt.toISOString() : null,
    publishedLast7Days,
    nextEligibleAt: nextEligibleAt ? nextEligibleAt.toISOString() : null
  };

  const posts = recentPosts.map((post) => ({
    id: post.id,
    slug: post.slug,
    title: post.title,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    updatedAt: post.updatedAt ? post.updatedAt.toISOString() : null
  }));

  return NextResponse.json({ ok: true, status, posts });
}
