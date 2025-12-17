import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, isNotNull, lte } from "drizzle-orm";
import { blogPosts, getDb } from "@/db";

function clampInt(value: string | null, { min, max, fallback }: { min: number; max: number; fallback: number }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return Math.max(min, Math.min(max, rounded));
}

export async function GET(request: NextRequest): Promise<Response> {
  const limit = clampInt(request.nextUrl.searchParams.get("limit"), { min: 1, max: 100, fallback: 20 });
  const offset = clampInt(request.nextUrl.searchParams.get("offset"), { min: 0, max: 100000, fallback: 0 });

  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({
      slug: blogPosts.slug,
      title: blogPosts.title,
      excerpt: blogPosts.excerpt,
      metaDescription: blogPosts.metaDescription,
      publishedAt: blogPosts.publishedAt,
      updatedAt: blogPosts.updatedAt
    })
    .from(blogPosts)
    .where(and(isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now)))
    .orderBy(desc(blogPosts.publishedAt))
    .limit(limit)
    .offset(offset);

  const posts = rows
    .filter((row) => row.publishedAt)
    .map((row) => ({
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt ?? row.metaDescription ?? null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
    }));

  return NextResponse.json({ ok: true, posts });
}

